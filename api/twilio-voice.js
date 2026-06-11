import twilio from 'twilio';
import { createClient } from '@supabase/supabase-js';

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');

  if (req.method === 'GET') {
    return res.status(200).send('<Response><Say>PitchLog is connected.</Say></Response>');
  }

  if (req.method !== 'POST') {
    return res.status(405).send('<Response></Response>');
  }

  // Validate Twilio signature against the URL exactly as requested — req.url preserves
  // the original encoding (Twilio normalizes %3A back to ':' etc., so rebuilding the
  // query string with URLSearchParams produces a different string and fails validation)
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

  // Disclosure whisper for the called party (child leg of an outbound dial)
  if (req.query.disclosure === '1') {
    return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?>\n<Response><Say voice="Polly.Joanna">This call may be recorded.</Say></Response>');
  }

  const { To, From, DialCallStatus } = req.body;
  const isClientCall = (From || '').startsWith('client:');

  const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    : null;

  /* ── INBOUND: someone calling one of our Twilio numbers ────────────────── */
  if (!isClientCall) {
    // Which user owns the number that was called?
    let ownerId = null;
    let ownerName = '';
    if (supabase && To) {
      try {
        const { data: owner } = await supabase
          .from('profiles')
          .select('id, full_name')
          .eq('twilio_phone_number', To)
          .single();
        ownerId = owner?.id || null;
        ownerName = owner?.full_name || '';
      } catch (e) {
        console.error('Inbound owner lookup error:', e);
      }
    }

    // Contact phone for the call log is the CALLER on inbound — pass it as "to"
    // so the recording pipeline upserts the right contact
    const cbParams = new URLSearchParams({
      user_id: ownerId || '',
      to: From || '',
      from: To || ''
    });
    const recordingCallback = xmlEscape(`${baseUrl}/api/twilio-recording?${cbParams.toString()}`);

    // Second leg: browser didn't answer (or finished) — action callback after <Dial>
    if (req.query.fallback === '1') {
      if (DialCallStatus === 'completed') {
        return res.status(200).send('<Response><Hangup/></Response>');
      }

      // Missed-call text-back: fire an SMS to the caller (real numbers only)
      const missedUserId = req.query.user_id || ownerId;
      if (missedUserId && From && /^\+\d{10,15}$/.test(From) && To &&
          process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
        try {
          // Don't double-text the same caller within 24h
          const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          const { data: recent } = await supabase.from('messages')
            .select('id')
            .eq('user_id', missedUserId)
            .eq('phone', From)
            .eq('direction', 'outbound')
            .gte('created_at', since)
            .limit(1);

          if (!recent?.length) {
            const firstName = (ownerName || '').split(/\s+/)[0];
            const txt = `Sorry I missed your call${firstName ? ` — this is ${firstName}` : ''}! What's the best time to reach you?`;
            const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
            const sms = await client.messages.create({ body: txt, from: To, to: From });

            const { data: contact } = await supabase.from('contacts')
              .select('id').eq('user_id', missedUserId).eq('phone', From).maybeSingle();
            await supabase.from('messages').insert({
              user_id: missedUserId, contact_id: contact?.id || null, phone: From,
              direction: 'outbound', body: txt, twilio_sid: sms.sid, read: true
            });
          }
        } catch (e) {
          console.error('Missed-call text-back error:', e);
        }
      }

      const greeting = ownerName
        ? `You have reached ${xmlEscape(ownerName)}. Please leave a message after the tone.`
        : 'Please leave a message after the tone.';
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${greeting}</Say>
  <Record maxLength="120" playBeep="true"
          recordingStatusCallback="${recordingCallback}"
          recordingStatusCallbackMethod="POST"/>
  <Say>Thank you. Goodbye.</Say>
</Response>`);
    }

    if (!ownerId) {
      return res.status(200).send('<Response><Say>This number is not configured. Goodbye.</Say><Hangup/></Response>');
    }

    // Ring the owner's browser dialer; fall through to voicemail via action URL
    const fallbackParams = new URLSearchParams({ fallback: '1', user_id: ownerId, to: From || '', from: To || '' });
    const actionUrl = xmlEscape(`${baseUrl}/api/twilio-voice?${fallbackParams.toString()}`);

    return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="20" record="record-from-answer-dual"
        recordingStatusCallback="${recordingCallback}"
        recordingStatusCallbackMethod="POST"
        action="${actionUrl}" method="POST">
    <Client>${xmlEscape(ownerId)}</Client>
  </Dial>
</Response>`);
  }

  /* ── OUTBOUND: browser dialer call (From = "client:<user.id>") ─────────── */
  if (!To) {
    return res.status(400).send('<Response><Say>No destination number.</Say></Response>');
  }

  const userId = (From || '').replace(/^client:/, '');
  let callerId = process.env.TWILIO_PHONE_NUMBER || null;
  let disclose = false;

  if (userId && userId.length === 36 && supabase) {
    try {
      const { data: profile } = await supabase
        .from('profiles')
        .select('twilio_phone_number, record_disclosure')
        .eq('id', userId)
        .single();
      if (profile?.twilio_phone_number) callerId = profile.twilio_phone_number;
      disclose = profile?.record_disclosure === true;
    } catch (e) {
      console.error('Profile lookup error:', e);
    }
  }

  // Recording status callbacks don't include From/To/CallDuration — pass them via query params
  const cbParams = new URLSearchParams({
    user_id: userId || '',
    to: To || '',
    from: callerId || ''
  });
  const recordingCallbackXml = xmlEscape(`${baseUrl}/api/twilio-recording?${cbParams.toString()}`);

  // Omit callerId attribute if we don't have one so Twilio uses account default;
  // strip everything but digits/+ from To (it's user input going into XML)
  const callerIdAttr = callerId ? ` callerId="${xmlEscape(callerId)}"` : '';
  const safeTo = To.replace(/[^\d+]/g, '');
  const whisperAttr = disclose ? ` url="${xmlEscape(`${baseUrl}/api/twilio-voice?disclosure=1`)}" method="POST"` : '';

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial record="record-from-answer-dual"
        recordingStatusCallback="${recordingCallbackXml}"
        recordingStatusCallbackMethod="POST"${callerIdAttr}>
    <Number${whisperAttr}>${safeTo}</Number>
  </Dial>
</Response>`;

  res.status(200).send(twiml);
}
