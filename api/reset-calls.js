import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  // Accept Authorization: Bearer <CRON_SECRET> (Vercel cron auto-injects this)
  // or x-cron-secret header / ?secret= query param for manual invocation
  const authHeader = req.headers['authorization'] || '';
  const bearerToken = authHeader.replace(/^Bearer\s+/i, '');
  const secret = bearerToken || req.headers['x-cron-secret'] || req.query.secret;
  if (!secret || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { error, count } = await supabase
    .from('profiles')
    .update({ calls_this_month: 0, billing_cycle_start: new Date().toISOString() })
    .eq('plan', 'free');

  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ success: true, reset: count || 0 });
}
