import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: false } };

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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

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
