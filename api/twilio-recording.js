import twilio from 'twilio';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const twilioSignature = req.headers['x-twilio-signature'] || '';
  const qs = Object.keys(req.query).length > 0 ? '?' + new URLSearchParams(req.query).toString() : '';
  const url = `https://${req.headers.host}/api/twilio-recording${qs}`;
  const valid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    twilioSignature,
    url,
    req.body || {}
  );
  if (!valid) return res.status(403).json({ error: 'Forbidden' });

  const { RecordingUrl, RecordingSid, CallSid, From, To, CallDuration, RecordingStatus } = req.body;
  if (RecordingStatus && RecordingStatus !== 'completed') {
    return res.status(200).json({ status: 'ignored' });
  }
  if (!RecordingUrl) return res.status(400).json({ error: 'No recording URL' });

  const userId = req.query.user_id || null;

  try {
    const audioUrl = `${RecordingUrl}.mp3`;
    const apiKey = process.env.ASSEMBLYAI_API_KEY;

    const twilioAudio = await fetch(audioUrl, {
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
        ).toString('base64')}`
      }
    });
    if (!twilioAudio.ok) throw new Error(`Twilio fetch failed: ${twilioAudio.status}`);
    const audioBuffer = Buffer.from(await twilioAudio.arrayBuffer());

    const uploadRes = await fetch('https://api.assemblyai.com/v2/upload', {
      method: 'POST',
      headers: { Authorization: apiKey, 'Content-Type': 'application/octet-stream' },
      body: audioBuffer
    });
    const { upload_url } = await uploadRes.json();

    const webhookUrl = `https://${req.headers.host}/api/assemblyai-webhook`;
    const submitRes = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio_url: upload_url, speaker_labels: true, webhook_url: webhookUrl })
    });
    const { id: transcriptId } = await submitRes.json();

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    await supabase.from('calls').insert({
      call_sid: CallSid,
      recording_sid: RecordingSid,
      recording_url: audioUrl,
      from_number: From,
      to_number: To,
      duration: parseInt(CallDuration) || 0,
      transcript: `PENDING:${transcriptId}`,
      notes: '',
      heat_score: null,
      sentiment: null,
      next_step: '',
      contact_id: null,
      user_id: userId
    });

    res.status(200).json({ status: 'pending', transcriptId });
  } catch (err) {
    console.error('Recording error:', err);
    res.status(500).json({ error: String(err) });
  }
}
