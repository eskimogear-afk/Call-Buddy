import twilio from 'twilio';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.TWILIO_AUTH_TOKEN)
    return res.status(500).json({ error: 'Missing env: TWILIO_AUTH_TOKEN' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY)
    return res.status(500).json({ error: 'Supabase not configured' });

  // Validate Twilio signature — URL includes query string because user_id is a query param
  const twilioSignature = req.headers['x-twilio-signature'] || '';
  const qs = Object.keys(req.query).length > 0 ? '?' + new URLSearchParams(req.query).toString() : '';
  const baseUrl = process.env.TWILIO_WEBHOOK_BASE_URL
    ? process.env.TWILIO_WEBHOOK_BASE_URL.replace(/\/$/, '')
    : `https://${req.headers.host}`;
  const webhookUrl = `${baseUrl}/api/twilio-recording${qs}`;

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

  const { RecordingUrl, RecordingSid, CallSid, From, To, CallDuration, RecordingStatus } = req.body;
  if (RecordingStatus && RecordingStatus !== 'completed') {
    return res.status(200).json({ status: 'ignored' });
  }
  if (!RecordingUrl) return res.status(400).json({ error: 'No recording URL' });

  const userId = req.query.user_id || null;
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // Always insert the call record, even if transcription fails
  let transcriptPlaceholder = 'PENDING:unknown';
  let transcriptId = null;

  try {
    if (!process.env.ASSEMBLYAI_API_KEY) throw new Error('ASSEMBLYAI_API_KEY not configured');

    const audioUrl = `${RecordingUrl}.mp3`;

    // Download the recording from Twilio
    const twilioAudio = await fetch(audioUrl, {
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
        ).toString('base64')}`
      }
    });
    if (!twilioAudio.ok) throw new Error(`Twilio audio fetch failed: ${twilioAudio.status}`);
    const audioBuffer = Buffer.from(await twilioAudio.arrayBuffer());

    // Upload to AssemblyAI
    const uploadRes = await fetch('https://api.assemblyai.com/v2/upload', {
      method: 'POST',
      headers: {
        Authorization: process.env.ASSEMBLYAI_API_KEY,
        'Content-Type': 'application/octet-stream'
      },
      body: audioBuffer
    });
    const uploadData = await uploadRes.json();
    if (!uploadData.upload_url) throw new Error('AssemblyAI upload failed: ' + JSON.stringify(uploadData));

    // Submit transcription job
    const recordingBase = process.env.TWILIO_WEBHOOK_BASE_URL
      ? process.env.TWILIO_WEBHOOK_BASE_URL.replace(/\/$/, '')
      : `https://${req.headers.host}`;
    const webhookCallbackUrl = `${recordingBase}/api/assemblyai-webhook`;

    const submitRes = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: {
        Authorization: process.env.ASSEMBLYAI_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        audio_url: uploadData.upload_url,
        speaker_labels: true,
        webhook_url: webhookCallbackUrl
      })
    });
    const submitData = await submitRes.json();
    if (!submitData.id) throw new Error('AssemblyAI submit failed: ' + JSON.stringify(submitData));

    transcriptId = submitData.id;
    transcriptPlaceholder = `PENDING:${transcriptId}`;
  } catch (transcriptionErr) {
    console.error('Transcription setup error (call will still be saved):', transcriptionErr);
    transcriptPlaceholder = `ERROR: ${transcriptionErr.message}`;
  }

  // Always insert the call record regardless of transcription success
  try {
    const audioUrl = `${RecordingUrl}.mp3`;
    const { error: insertErr } = await supabase.from('calls').insert({
      call_sid: CallSid,
      recording_sid: RecordingSid,
      recording_url: audioUrl,
      from_number: From,
      to_number: To,
      duration: parseInt(CallDuration) || 0,
      transcript: transcriptPlaceholder,
      notes: transcriptId ? '' : 'Transcription could not be started — check AssemblyAI API key',
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
