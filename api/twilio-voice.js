import twilio from 'twilio';

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

  const { To } = req.body;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial record="record-from-answer-dual"
        recordingStatusCallback="https://${req.headers.host}/api/twilio-recording"
        recordingStatusCallbackMethod="POST"
        callerId="${process.env.TWILIO_PHONE_NUMBER}">
    <Number>${To}</Number>
  </Dial>
</Response>`;

  res.status(200).send(twiml);
}
