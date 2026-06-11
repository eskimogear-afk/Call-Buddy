const SITE_URL = 'https://call-buddy-omega.vercel.app';
const SUPABASE_URL = 'https://sbwtidnoxtmalmuifdxf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNid3RpZG5veHRtYWxtdWlmZHhmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzNjAxNjksImV4cCI6MjA5NTkzNjE2OX0.l56bD3lcSlY1KVwPWydwc9V1ptE5If5-qroMPX-e_2U';

const FREE_LIMIT = 25;
const PLAN_LIMITS = { free: 25, starter: 100, pro: Infinity, team: Infinity };

const STRIPE_KEY = 'pk_test_51TdiCs2RgYWz496ckaoC48If1Jfq5sbU8PS8yciSzcEaLYjQB0HCtbYj7zcccIx9UFC12ExbzvC9gFIn6QJfnbBO00TpE7MDuG';

// Replace with your Stripe Price IDs after creating products in the dashboard
const STRIPE_PRICES = {
  starter: { monthly: 'price_STARTER_MONTHLY', annual: 'price_STARTER_ANNUAL' },
  pro:     { monthly: 'price_1TeRFh2RgYWz496cuMTZVogj', annual: 'price_PRO_ANNUAL' },
  team:    { monthly: 'price_TEAM_MONTHLY', annual: 'price_TEAM_ANNUAL' }
};

const PLAN_LABELS = {
  free: 'Free — 25 calls/month',
  starter: 'Starter — 100 calls/month',
  pro: 'Pro — unlimited calls',
  team: 'Team — unlimited + 5 seats'
};

const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
