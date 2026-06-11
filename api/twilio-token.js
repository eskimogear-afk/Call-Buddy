import twilio from 'twilio';
import { createClient } from '@supabase/supabase-js';

const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;

const ALLOWED_ORIGIN = 'https://call-buddy-omega.vercel.app';
const FREE_PLAN_LIMIT = 25;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY)
    return res.status(500).json({ error: 'Supabase not configured' });
  if (!process.env.TWILIO_ACCOUNT_SID)
    return res.status(500).json({ error: 'Missing env: TWILIO_ACCOUNT_SID' });
  if (!process.env.TWILIO_AUTH_TOKEN && !process.env.TWILIO_API_SECRET)
    return res.status(500).json({ error: 'Missing env: TWILIO_AUTH_TOKEN or TWILIO_API_SECRET' });
  if (!process.env.TWILIO_TWIML_APP_SID)
    return res.status(500).json({ error: 'Missing env: TWILIO_TWIML_APP_SID (create a TwiML App in Twilio console → starts with AP...)' });

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  let user;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return res.status(401).json({ error: 'Unauthorized' });
    user = data.user;
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('plan, calls_this_month')
    .eq('id', user.id)
    .single();

  if (profile?.plan === 'free' && (profile?.calls_this_month || 0) >= FREE_PLAN_LIMIT) {
    return res.status(403).json({ error: 'Monthly call limit reached. Upgrade to Pro for unlimited calls.' });
  }

  try {
    // Prefer dedicated API Key (SK...) — falls back to Account SID + Auth Token which Twilio also accepts.
    // Using TWILIO_ACCOUNT_SID as keySid with TWILIO_AUTH_TOKEN as secret is valid for AccessToken generation.
    const keySid = process.env.TWILIO_API_KEY || process.env.TWILIO_ACCOUNT_SID;
    const keySecret = process.env.TWILIO_API_SECRET || process.env.TWILIO_AUTH_TOKEN;

    const accessToken = new AccessToken(
      process.env.TWILIO_ACCOUNT_SID,
      keySid,
      keySecret,
      { identity: user.id, ttl: 3600 }
    );

    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID,
      incomingAllow: true
    });

    accessToken.addGrant(voiceGrant);
    res.status(200).json({ token: accessToken.toJwt(), identity: user.id });
  } catch (err) {
    console.error('Token error:', err);
    res.status(500).json({ error: 'Token error' });
  }
}
