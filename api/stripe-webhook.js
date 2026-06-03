import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(400).json({ error: 'Webhook Error: ' + err.message });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.client_reference_id;
        if (!userId) break;
        await supabase.from('profiles').update({
          plan: 'pro',
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
        const plan = sub.status === 'active' ? 'pro' : 'free';
        await supabase.from('profiles').update({
          plan,
          updated_at: new Date().toISOString()
        }).eq('stripe_subscription_id', sub.id);
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        console.log('Payment failed for customer:', invoice.customer);
        break;
      }
    }
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }

  return res.status(200).json({ received: true });
}
