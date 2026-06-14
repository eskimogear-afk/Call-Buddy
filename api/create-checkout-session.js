import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

// success/cancel can only return to an origin we trust
const ALLOWED_ORIGINS = ['https://call-buddy-omega.vercel.app'];

// tier -> env var holding its Stripe price ID. These are the SAME env vars the
// webhook (api/stripe-webhook.js priceToPlan) maps back to a plan, so price IDs
// have exactly one home: Vercel env. Nothing price-related lives in the client.
const TIER_PRICE_ENV = {
  solo_monthly: 'STRIPE_PRICE_SOLO_MONTHLY',
  solo_annual:  'STRIPE_PRICE_SOLO_ANNUAL',
  pro_monthly:  'STRIPE_PRICE_PRO_MONTHLY',
  pro_annual:   'STRIPE_PRICE_PRO_ANNUAL',
  team_monthly: 'STRIPE_PRICE_TEAM_MONTHLY'
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return res.status(500).json({ error: 'Supabase not configured' });

  // Identify the buyer from their Supabase session — the webhook keys the plan
  // upgrade off this id (client_reference_id), so it must be the real user.
  const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });

  const { tier = 'solo_monthly', seats } = req.body || {};
  const priceEnv = TIER_PRICE_ENV[tier];
  if (!priceEnv) return res.status(400).json({ error: 'Unknown plan' });
  const priceId = process.env[priceEnv];

  // Stripe not set up yet (no secret key or this price isn't configured) →
  // tell the client to fall back to the email-the-founder flow. This keeps the
  // current behaviour intact until the dashboard products + env vars exist.
  if (!process.env.STRIPE_SECRET_KEY || !priceId) {
    return res.status(200).json({ configured: false });
  }

  let quantity = 1;
  if (tier === 'team_monthly') {
    quantity = parseInt(seats, 10) || 0;
    if (quantity < 2) return res.status(400).json({ error: 'Team plan needs at least 2 seats' });
  }

  const origin = ALLOWED_ORIGINS.includes(req.headers.origin) ? req.headers.origin : ALLOWED_ORIGINS[0];

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

    // Reuse an existing Stripe customer for this user if we have one, so we don't
    // create duplicate customers on re-subscribe.
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
    console.error('create-checkout-session error:', e.message);
    return res.status(500).json({ error: 'Could not start checkout' });
  }
}
