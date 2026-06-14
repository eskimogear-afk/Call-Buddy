import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: false } };

// success/cancel can only return to an origin we trust
const ALLOWED_ORIGINS = ['https://call-buddy-omega.vercel.app'];

// tier -> env var holding its Stripe price ID. The SAME vars priceToPlan maps
// back, so price IDs have exactly one home (Vercel env); nothing in the client.
const TIER_PRICE_ENV = {
  solo_monthly: 'STRIPE_PRICE_SOLO_MONTHLY',
  solo_annual:  'STRIPE_PRICE_SOLO_ANNUAL',
  pro_monthly:  'STRIPE_PRICE_PRO_MONTHLY',
  pro_annual:   'STRIPE_PRICE_PRO_ANNUAL',
  team_monthly: 'STRIPE_PRICE_TEAM_MONTHLY'
};

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Map a Stripe price ID to a PitchLog plan via env vars (set after creating
// the products in the Stripe Dashboard). Unknown prices return null.
function priceToPlan(priceId) {
  if (!priceId) return null;
  const map = {
    [process.env.STRIPE_PRICE_SOLO_MONTHLY]: 'solo',
    [process.env.STRIPE_PRICE_SOLO_ANNUAL]: 'solo',
    [process.env.STRIPE_PRICE_PRO_MONTHLY]: 'pro',
    [process.env.STRIPE_PRICE_PRO_ANNUAL]: 'pro',
    [process.env.STRIPE_PRICE_TEAM_MONTHLY]: 'team'
  };
  return map[priceId] || null;
}

// Start a subscription Checkout Session. Lives in this function (not its own
// file) to stay under Vercel's 12-function limit; the webhook proper is the
// signed call from Stripe, this is the unsigned call from our own app.
async function handleCreateCheckout(req, res) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return res.status(500).json({ error: 'Supabase not configured' });

  // Identify the buyer — the webhook keys the upgrade off this id.
  const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });

  let body = {};
  try { const raw = await getRawBody(req); body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { body = {}; }
  const tier = body.tier || 'solo_monthly';
  const priceEnv = TIER_PRICE_ENV[tier];
  if (!priceEnv) return res.status(400).json({ error: 'Unknown plan' });
  const priceId = process.env[priceEnv];

  // Not set up yet (no secret key / this price not configured) → client falls
  // back to the email-the-founder flow. Keeps current behaviour until ready.
  if (!process.env.STRIPE_SECRET_KEY || !priceId) return res.status(200).json({ configured: false });

  let quantity = 1;
  if (tier === 'team_monthly') {
    quantity = parseInt(body.seats, 10) || 0;
    if (quantity < 2) return res.status(400).json({ error: 'Team plan needs at least 2 seats' });
  }

  const origin = ALLOWED_ORIGINS.includes(req.headers.origin) ? req.headers.origin : ALLOWED_ORIGINS[0];

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
    // reuse an existing Stripe customer for this user so re-subscribes don't dupe
    const { data: prof } = await supabase.from('profiles').select('stripe_customer_id').eq('id', user.id).maybeSingle();
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity }],
      client_reference_id: user.id,
      ...(prof?.stripe_customer_id ? { customer: prof.stripe_customer_id } : { customer_email: user.email }),
      allow_promotion_codes: true,
      success_url: origin + '/?upgraded=true',
      cancel_url: origin + '/?upgrade_cancelled=true',
      metadata: { user_id: user.id, tier },
      subscription_data: { metadata: { user_id: user.id, tier } }
    });
    return res.status(200).json({ configured: true, url: session.url });
  } catch (e) {
    console.error('create-checkout error:', e.message);
    return res.status(500).json({ error: 'Could not start checkout' });
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Stripe always signs its webhook deliveries. An unsigned POST is our own app
  // asking to START a checkout, so route it there (it auth-checks the user).
  if (!req.headers['stripe-signature']) return handleCreateCheckout(req, res);

  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(400).json({ error: 'Webhook Error: ' + err.message });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.client_reference_id;
        if (!userId) break;
        let plan = 'solo';
        try {
          const items = await stripe.checkout.sessions.listLineItems(session.id, { limit: 5 });
          plan = priceToPlan(items?.data?.[0]?.price?.id) || 'solo';
        } catch (e) { console.error('line-item lookup failed', e); }
        await supabase.from('profiles').update({
          plan,
          stripe_customer_id: session.customer,
          stripe_subscription_id: session.subscription,
          calls_this_month: 0,
          updated_at: new Date().toISOString()
        }).eq('id', userId);
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await supabase.from('profiles').update({
          plan: 'free',
          stripe_subscription_id: null,
          calls_this_month: 0,
          updated_at: new Date().toISOString()
        }).eq('stripe_subscription_id', sub.id);
        break;
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        // Never clobber grandfathered founders on routine sub updates
        const { data: prof } = await supabase.from('profiles').select('plan')
          .eq('stripe_subscription_id', sub.id).maybeSingle();
        if (prof?.plan === 'pro_legacy') break;
        const mapped = priceToPlan(sub.items?.data?.[0]?.price?.id);
        const plan = sub.status === 'active' ? (mapped || prof?.plan || 'solo') : 'free';
        await supabase.from('profiles').update({
          plan,
          updated_at: new Date().toISOString()
        }).eq('stripe_subscription_id', sub.id);
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        if (invoice.subscription) {
          await supabase.from('profiles').update({
            payment_failed: true,
            updated_at: new Date().toISOString()
          }).eq('stripe_subscription_id', invoice.subscription);
        }
        break;
      }
    }
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }

  return res.status(200).json({ received: true });
}
