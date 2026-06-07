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

  const twilioSignature = req.headers['x-twilio-signature'] || '';
  const url = `https://${req.headers.host}/api/twilio-voice`;
  const valid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    twilioSignature,
    url,
    req.body || {}
  );
  if (!valid) {
    return res.status(403).send('<Response></Response>');
  }

  const { To, From } = req.body;

  // From = Twilio client identity = user.id — look up user's provisioned number
  let callerId = process.env.TWILIO_PHONE_NUMBER;
  const userId = From;
  if (userId && userId.length === 36 && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: profile } = await supabase
      .from('profiles')
      .select('twilio_phone_number')
      .eq('id', userId)
      .single();
    if (profile?.twilio_phone_number) callerId = profile.twilio_phone_number;
  }

  const recordingCallback = `https://${req.headers.host}/api/twilio-recording?user_id=${encodeURIComponent(userId || '')}`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial record="record-from-answer-dual"
        recordingStatusCallback="${recordingCallback}"
        recordingStatusCallbackMethod="POST"
        callerId="${callerId}">
    <Number>${To}</Number>
  </Dial>
</Response>`;

  res.status(200).send(twiml);
}
