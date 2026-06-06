import twilio from 'twilio';

const authToken = process.env.TWILIO_AUTH_TOKEN;

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');

  if (req.method === 'GET') {
    return res.status(200).send('<Response><Say>PitchLog is connected.</Say></Response>');
  }

  const { To, From } = req.body;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial record="record-from-answer-dual"
        recordingStatusCallback="/api/twilio-recording"
        recordingStatusCallbackMethod="POST"
        callerId="${process.env.TWILIO_PHONE_NUMBER}">
    <Number>${To}</Number>
  </Dial>
</Response>`;

  res.status(200).send(twiml);
}
