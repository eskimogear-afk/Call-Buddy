import twilio from 'twilio';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');

  if (req.method === 'GET') {
    return res.status(200).send('<Response><Say>Call Buddy is connected.</Say></Response>');
  }

  if (req.method !== 'POST') {
    return res.status(405).send('<Response></Response>');
  }

  // Validate Twilio signature.
  // Use TWILIO_WEBHOOK_BASE_URL env var if set (must match exactly what's in Twilio console TwiML App).
  // Falls back to reconstructing from the host header.
  const twilioSignature = req.headers['x-twilio-signature'] || '';
  const baseUrl = process.env.TWILIO_WEBHOOK_BASE_URL
    ? process.env.TWILIO_WEBHOOK_BASE_URL.replace(/\/$/, '')
    : `https://${req.headers.host}`;
  const webhookUrl = `${baseUrl}${req.url}`;

  if (process.env.TWILIO_AUTH_TOKEN) {
    const valid = twilio.validateRequest(
      process.env.TWILIO_AUTH_TOKEN,
      twilioSignature,
      webhookUrl,
      req.body || {}
    );
    if (!valid) {
      console.error('Sig validation failed. Expected URL:', webhookUrl, 'Sig:', twilioSignature);
      return res.status(403).send('<Response><Say>Forbidden</Say></Response>');
    }
  }

  const { To, From } = req.body;
  if (!To) {
    return res.status(400).send('<Response><Say>No destination number.</Say></Response>');
  }

  // From = "client:<user.id>" for browser calls — strip the client: prefix
  const userId = (From || '').replace(/^client:/, '');
  let callerId = process.env.TWILIO_PHONE_NUMBER || null;

  if (userId && userId.length === 36 && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    try {
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { data: profile } = await supabase
        .from('profiles')
        .select('twilio_phone_number')
        .eq('id', userId)
        .single();
      if (profile?.twilio_phone_number) callerId = profile.twilio_phone_number;
    } catch (e) {
      console.error('Profile lookup error:', e);
    }
  }

  const recordingBase = process.env.TWILIO_WEBHOOK_BASE_URL
    ? process.env.TWILIO_WEBHOOK_BASE_URL.replace(/\/$/, '')
    : `https://${req.headers.host}`;
  // Recording status callbacks don't include From/To/CallDuration — pass them via query params
  const cbParams = new URLSearchParams({
    user_id: userId || '',
    to: To || '',
    from: callerId || ''
  });
  const recordingCallback = `${recordingBase}/api/twilio-recording?${cbParams.toString()}`;

  // Build Dial verb — omit callerId attribute if we don't have one so Twilio uses account default
  const callerIdAttr = callerId ? ` callerId="${callerId}"` : '';

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial record="record-from-answer-dual"
        recordingStatusCallback="${recordingCallback}"
        recordingStatusCallbackMethod="POST"${callerIdAttr}>
    <Number>${To}</Number>
  </Dial>
</Response>`;

  res.status(200).send(twiml);
}
