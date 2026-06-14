#!/usr/bin/env node
/*
 * One-shot Stripe setup for PitchLog.
 *
 * It creates the 5 subscription prices + the webhook endpoint in YOUR Stripe
 * account and (optionally) writes the 7 env vars into Vercel. Your secret key
 * stays on this machine — it is read from the environment, never hard-coded.
 *
 * Usage (TEST mode — do this first):
 *   STRIPE_SECRET_KEY=sk_test_xxx node scripts/setup-stripe.mjs              # create + print
 *   STRIPE_SECRET_KEY=sk_test_xxx node scripts/setup-stripe.mjs --push-vercel # also set Vercel env
 *
 * When you're ready to charge real money, repeat with a LIVE key:
 *   STRIPE_SECRET_KEY=sk_live_xxx node scripts/setup-stripe.mjs --push-vercel --live
 *
 * Safe to re-run: prices are matched by lookup_key and reused, the webhook is
 * matched by URL. (A webhook's signing secret is only shown when first created.)
 */
import { execSync } from 'node:child_process';

const KEY = process.env.STRIPE_SECRET_KEY;
if (!KEY) {
  console.error('Set your key first:  STRIPE_SECRET_KEY=sk_test_xxx node scripts/setup-stripe.mjs');
  process.exit(1);
}
const LIVE = KEY.startsWith('sk_live_');
const args = process.argv.slice(2);
const pushVercel = args.includes('--push-vercel');
if (LIVE && !args.includes('--live')) {
  console.error('That is a LIVE key. Re-run with --live if you really mean to create live products (use a sk_test_ key first).');
  process.exit(1);
}
const MODE = LIVE ? 'LIVE' : 'TEST';
const WEBHOOK_URL = 'https://call-buddy-omega.vercel.app/api/stripe-webhook';
const WEBHOOK_EVENTS = ['checkout.session.completed', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.payment_failed'];

const PRICES = [
  { env: 'STRIPE_PRICE_SOLO_MONTHLY', lookup: 'pitchlog_solo_monthly', name: 'PitchLog Solo (monthly)',          amount: 4900,  interval: 'month' },
  { env: 'STRIPE_PRICE_SOLO_ANNUAL',  lookup: 'pitchlog_solo_annual',  name: 'PitchLog Solo (annual)',           amount: 46800, interval: 'year'  },
  { env: 'STRIPE_PRICE_PRO_MONTHLY',  lookup: 'pitchlog_pro_monthly',  name: 'PitchLog Pro (monthly)',           amount: 8900,  interval: 'month' },
  { env: 'STRIPE_PRICE_PRO_ANNUAL',   lookup: 'pitchlog_pro_annual',   name: 'PitchLog Pro (annual)',            amount: 94800, interval: 'year'  },
  { env: 'STRIPE_PRICE_TEAM_MONTHLY', lookup: 'pitchlog_team_monthly', name: 'PitchLog Team (per seat / month)', amount: 7900,  interval: 'month' }
];

async function stripe(path, method = 'GET', form) {
  const opts = { method, headers: { Authorization: 'Bearer ' + KEY } };
  if (form) {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(form).toString();
  }
  const r = await fetch('https://api.stripe.com/v1/' + path, opts);
  const j = await r.json();
  if (!r.ok) throw new Error(`Stripe ${method} /${path.split('?')[0]} → ${j.error?.message || r.status}`);
  return j;
}

const out = {};
console.log(`\n▶ Stripe setup — ${MODE} mode\n`);

try {
  for (const p of PRICES) {
    const found = await stripe(`prices?lookup_keys[]=${encodeURIComponent(p.lookup)}&limit=1`);
    let price = found.data?.[0];
    if (price) {
      console.log(`  = ${p.lookup.padEnd(22)} reuse ${price.id}`);
    } else {
      price = await stripe('prices', 'POST', {
        currency: 'usd',
        unit_amount: String(p.amount),
        'recurring[interval]': p.interval,
        'product_data[name]': p.name,
        lookup_key: p.lookup
      });
      console.log(`  + ${p.lookup.padEnd(22)} created ${price.id}`);
    }
    out[p.env] = price.id;
  }

  const hooks = await stripe('webhook_endpoints?limit=100');
  let hook = hooks.data?.find(h => h.url === WEBHOOK_URL);
  if (hook) {
    console.log(`  = webhook                exists ${hook.id} (keep your existing STRIPE_WEBHOOK_SECRET)`);
  } else {
    const form = { url: WEBHOOK_URL };
    WEBHOOK_EVENTS.forEach((e, i) => { form[`enabled_events[${i}]`] = e; });
    hook = await stripe('webhook_endpoints', 'POST', form);
    out['STRIPE_WEBHOOK_SECRET'] = hook.secret;
    console.log(`  + webhook                created ${hook.id}`);
  }
  out['STRIPE_SECRET_KEY'] = KEY;
} catch (e) {
  console.error('\n✗ ' + e.message);
  process.exit(1);
}

console.log('\n=== Env vars (' + MODE + ') ===');
for (const [k, v] of Object.entries(out)) {
  const masked = /SECRET|KEY/.test(k);
  console.log(`${k}=${masked ? v.slice(0, 8) + '…' : v}`);
}

if (pushVercel) {
  console.log('\n▶ Writing to Vercel (Production)…');
  for (const [k, v] of Object.entries(out)) {
    try { execSync(`vercel env rm ${k} production -y`, { stdio: 'ignore' }); } catch (e) { /* not set yet */ }
    execSync(`vercel env add ${k} production`, { input: v, stdio: ['pipe', 'ignore', 'ignore'] });
    console.log(`  set ${k}`);
  }
  console.log('\n✓ Vercel env set. Trigger a redeploy to apply:  vercel --prod   (or push any commit)');
  if (!out['STRIPE_WEBHOOK_SECRET']) {
    console.log('\nNote: the webhook already existed, so its signing secret was not re-shown.');
    console.log('If STRIPE_WEBHOOK_SECRET isn\'t already in Vercel, roll it in the Stripe Dashboard');
    console.log('(Developers → Webhooks → your endpoint → Signing secret) and add it manually.');
  }
} else {
  console.log('\nRe-run with --push-vercel to write these into Vercel automatically,');
  console.log('or paste them into Vercel → Settings → Environment Variables (Production).');
  console.log('Then redeploy. Test checkout with card 4242 4242 4242 4242.');
}
