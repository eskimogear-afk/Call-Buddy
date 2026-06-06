import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function pollTranscript(id, apiKey) {
  for (let i = 0; i < 25; i++) {
    const r = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
      headers: { Authorization: apiKey }
    });
    const data = await r.json();
    if (data.status === 'completed') return data;
    if (data.status === 'error') throw new Error(data.error);
    await new Promise(res => setTimeout(res, 2000));
  }
  throw new Error('Transcription timed out');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { RecordingUrl, RecordingSid, CallSid, From, To, CallDuration, RecordingStatus } = req.body;
  if (RecordingStatus && RecordingStatus !== 'completed') {
    return res.status(200).json({ status: 'ignored' });
  }
  if (!RecordingUrl) return res.status(400).json({ error: 'No recording URL' });

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

    const submitRes = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio_url: upload_url, speaker_labels: true })
    });
    const { id } = await submitRes.json();

    const result = await pollTranscript(id, apiKey);
    const transcript = result.text || '';
    if (!transcript) return res.status(200).json({ status: 'no_speech' });

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: `Analyze this cold call transcript. Return ONLY valid JSON with keys: name, company, notes (2-3 sentence summary), heatScore (0-100), sentiment (positive|neutral|negative), nextStep. Use "Unknown" if a field is unclear.\n\nTranscript:\n${transcript}`
        }]
      })
    });

    let analysis = {};
    if (anthropicRes.ok) {
      const aData = await anthropicRes.json();
      const text = aData.content?.find(b => b.type === 'text')?.text || '{}';
      try { analysis = JSON.parse(text.replace(/```json|```/g, '').trim()); }
      catch { analysis = { notes: 'Analysis failed', heatScore: 50 }; }
    }

    const phone = To || From || 'unknown';
    const { data: contact } = await supabase
      .from('contacts')
      .upsert({
        phone,
        name: analysis.name && analysis.name !== 'Unknown' ? analysis.name : 'Unknown',
        company: analysis.company && analysis.company !== 'Unknown' ? analysis.company : '',
        heat_score: analysis.heatScore || 50,
        last_called: new Date().toISOString()
      }, { onConflict: 'phone' })
      .select()
      .single();

    await supabase.from('calls').insert({
      call_sid: CallSid,
      recording_sid: RecordingSid,
      recording_url: audioUrl,
      from_number: From,
      to_number: To,
      duration: parseInt(CallDuration) || 0,
      transcript,
      notes: analysis.notes || '',
      heat_score: analysis.heatScore || 50,
      sentiment: analysis.sentiment || 'neutral',
      next_step: analysis.nextStep || '',
      contact_id: contact?.id || null
    });

    res.status(200).json({ success: true, heatScore: analysis.heatScore, name: analysis.name });
  } catch (err) {
    console.error('Recording error:', err);
    res.status(500).json({ error: String(err) });
  }
}
