import twilio from 'twilio';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.TWILIO_AUTH_TOKEN)
    return res.status(500).json({ error: 'Missing env: TWILIO_AUTH_TOKEN' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY)
    return res.status(500).json({ error: 'Supabase not configured' });

  // Validate Twilio signature against the URL exactly as requested — req.url preserves
  // the original encoding (Twilio normalizes %3A back to ':' etc., so rebuilding the
  // query string with URLSearchParams produces a different string and fails validation)
  const twilioSignature = req.headers['x-twilio-signature'] || '';
  const baseUrl = process.env.TWILIO_WEBHOOK_BASE_URL
    ? process.env.TWILIO_WEBHOOK_BASE_URL.replace(/\/$/, '')
    : `https://${req.headers.host}`;
  const webhookUrl = `${baseUrl}${req.url}`;

  const valid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    twilioSignature,
    webhookUrl,
    req.body || {}
  );
  if (!valid) {
    console.error('Recording sig validation failed. URL:', webhookUrl);
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { RecordingUrl, RecordingSid, CallSid, RecordingDuration, RecordingStatus } = req.body;
  if (RecordingStatus && RecordingStatus !== 'completed') {
    return res.status(200).json({ status: 'ignored' });
  }
  if (!RecordingUrl) return res.status(400).json({ error: 'No recording URL' });

  // Recording callbacks don't carry From/To/CallDuration — twilio-voice.js passes them via query params
  const rawUserId = (req.query.user_id || '').replace(/^client:/, '');
  const userId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawUserId) ? rawUserId : null;
  const From = req.query.from || req.body.From || null;
  const To = req.query.to || req.body.To || null;
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // Always insert the call record, even if transcription fails
  let transcriptPlaceholder = 'PENDING:unknown';
  let transcriptId = null;

  const recordingBase = process.env.TWILIO_WEBHOOK_BASE_URL
    ? process.env.TWILIO_WEBHOOK_BASE_URL.replace(/\/$/, '')
    : `https://${req.headers.host}`;
  const audioUrl = `${RecordingUrl}.mp3`;

  // Download the recording from Twilio once (used by whichever STT engine runs)
  let audioBuffer = null;
  try {
    const twilioAudio = await fetch(audioUrl, {
      headers: { Authorization: `Basic ${Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64')}` }
    });
    if (!twilioAudio.ok) throw new Error(`Twilio audio fetch failed: ${twilioAudio.status}`);
    audioBuffer = Buffer.from(await twilioAudio.arrayBuffer());
  } catch (e) {
    console.error('Recording download failed:', e.message);
    transcriptPlaceholder = `ERROR: ${e.message}`;
  }

  // ── PRIMARY: Deepgram. POST the audio with an async callback so this webhook
  //    stays fast; Deepgram transcribes and POSTs the result to our callback. ──
  if (audioBuffer && process.env.DEEPGRAM_API_KEY) {
    try {
      const cb = `${recordingBase}/api/assemblyai-webhook?dg=1&call_sid=${encodeURIComponent(CallSid || '')}`;
      const dgUrl = `https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&punctuate=true&diarize=true&callback=${encodeURIComponent(cb)}`;
      const dgRes = await fetch(dgUrl, {
        method: 'POST',
        headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, 'Content-Type': 'audio/mpeg' },
        body: audioBuffer
      });
      const dgData = await dgRes.json();
      const reqId = dgData.request_id || dgData.requestId;
      if (dgRes.ok && reqId) {
        transcriptId = reqId;
        transcriptPlaceholder = `PENDING:dg:${reqId}`;
      } else {
        throw new Error('Deepgram submit failed: ' + JSON.stringify(dgData).slice(0, 160));
      }
    } catch (e) {
      console.error('Deepgram failed — falling back to AssemblyAI:', e.message);
    }
  }

  // ── FALLBACK: AssemblyAI (only if Deepgram didn't start a job) ──
  if (!transcriptId && audioBuffer && process.env.ASSEMBLYAI_API_KEY) {
    try {
      const uploadRes = await fetch('https://api.assemblyai.com/v2/upload', {
        method: 'POST',
        headers: { Authorization: process.env.ASSEMBLYAI_API_KEY, 'Content-Type': 'application/octet-stream' },
        body: audioBuffer
      });
      const uploadData = await uploadRes.json();
      if (!uploadData.upload_url) throw new Error('AssemblyAI upload failed: ' + JSON.stringify(uploadData));
      const submitRes = await fetch('https://api.assemblyai.com/v2/transcript', {
        method: 'POST',
        headers: { Authorization: process.env.ASSEMBLYAI_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audio_url: uploadData.upload_url,
          speaker_labels: true,
          webhook_url: `${recordingBase}/api/assemblyai-webhook`,
          ...(process.env.AAI_WEBHOOK_SECRET ? { webhook_auth_header_name: 'x-aai-secret', webhook_auth_header_value: process.env.AAI_WEBHOOK_SECRET } : {})
        })
      });
      const submitData = await submitRes.json();
      if (!submitData.id) throw new Error('AssemblyAI submit failed: ' + JSON.stringify(submitData));
      transcriptId = submitData.id;
      transcriptPlaceholder = `PENDING:${transcriptId}`;
    } catch (e) {
      console.error('AssemblyAI fallback failed:', e.message);
      transcriptPlaceholder = `ERROR: ${e.message}`;
    }
  }

  // Always insert the call record regardless of transcription success
  try {
    const { error: insertErr } = await supabase.from('calls').insert({
      call_sid: CallSid,
      recording_sid: RecordingSid,
      recording_url: audioUrl,
      from_number: From,
      to_number: To,
      duration: parseInt(RecordingDuration) || 0,
      transcript: transcriptPlaceholder,
      notes: transcriptId ? '' : 'Transcription could not be started',
      heat_score: null,
      sentiment: null,
      next_step: '',
      contact_id: null,
      user_id: userId
    });
    if (insertErr) console.error('Call insert error:', insertErr);
  } catch (dbErr) {
    console.error('DB insert error:', dbErr);
  }

  res.status(200).json({ status: transcriptId ? 'pending' : 'saved_no_transcript', transcriptId });
}
