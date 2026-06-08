import { createClient } from '@supabase/supabase-js';

// Admin-only diagnostic endpoint — shows which env vars are configured
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://call-buddy-omega.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Secret');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.ADMIN_SECRET)
    return res.status(500).json({ error: 'ADMIN_SECRET not configured' });
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET)
    return res.status(401).json({ error: 'Unauthorized' });

  const check = (key) => ({
    set: !!process.env[key],
    preview: process.env[key] ? process.env[key].slice(0, 6) + '...' : null
  });

  const config = {
    supabase: {
      SUPABASE_URL: check('SUPABASE_URL'),
      SUPABASE_SERVICE_KEY: check('SUPABASE_SERVICE_KEY')
    },
    twilio: {
      TWILIO_ACCOUNT_SID: check('TWILIO_ACCOUNT_SID'),
      TWILIO_AUTH_TOKEN: check('TWILIO_AUTH_TOKEN'),
      TWILIO_API_KEY: check('TWILIO_API_KEY'),
      TWILIO_API_SECRET: check('TWILIO_API_SECRET'),
      TWILIO_TWIML_APP_SID: check('TWILIO_TWIML_APP_SID'),
      TWILIO_PHONE_NUMBER: check('TWILIO_PHONE_NUMBER'),
      TWILIO_WEBHOOK_BASE_URL: check('TWILIO_WEBHOOK_BASE_URL')
    },
    ai: {
      ANTHROPIC_API_KEY: check('ANTHROPIC_API_KEY'),
      ASSEMBLYAI_API_KEY: check('ASSEMBLYAI_API_KEY')
    },
    stripe: {
      STRIPE_SECRET_KEY: check('STRIPE_SECRET_KEY'),
      STRIPE_WEBHOOK_SECRET: check('STRIPE_WEBHOOK_SECRET')
    },
    cron: {
      CRON_SECRET: check('CRON_SECRET'),
      ADMIN_SECRET: check('ADMIN_SECRET')
    },
    readiness: {
      can_issue_tokens: !!(process.env.TWILIO_ACCOUNT_SID && (process.env.TWILIO_AUTH_TOKEN || process.env.TWILIO_API_SECRET) && process.env.TWILIO_TWIML_APP_SID),
      can_make_calls: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
      can_transcribe: !!process.env.ASSEMBLYAI_API_KEY,
      can_analyse: !!process.env.ANTHROPIC_API_KEY,
      can_send_sms: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
    }
  };

  // Optionally verify DB connection
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    try {
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { count } = await supabase.from('profiles').select('id', { count: 'exact', head: true });
      config.supabase.db_connected = true;
      config.supabase.profile_count = count;
    } catch (e) {
      config.supabase.db_connected = false;
      config.supabase.db_error = e.message;
    }
  }

  return res.status(200).json(config);
}
