import twilio from 'twilio';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.TWILIO_AUTH_TOKEN)
    return res.status(500).json({ error: 'Missing env: TWILIO_AUTH_TOKEN' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY)
    return res.status(500).json({ error: 'Supabase not configured' });

  // ── Re-transcribe an existing call (user-triggered recovery). Authenticated by
  //    the user's Supabase JWT, NOT a Twilio signature — so it runs before the
  //    signature gate. Re-downloads the saved recording and re-submits to Deepgram
  //    with the async callback; the webhook then completes it like a fresh call. ──
  if (req.query.retranscribe === '1') {
    if (!process.env.DEEPGRAM_API_KEY) return res.status(500).json({ error: 'Deepgram not configured' });
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Not signed in' });
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: { user } = {}, error: authErr } = await sb.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: 'Invalid session' });
    const callId = (req.body && req.body.call_id) || req.query.call_id;
    if (!callId) return res.status(400).json({ error: 'call_id required' });
    const { data: call } = await sb.from('calls')
      .select('id, recording_url, call_sid, user_id').eq('id', callId).eq('user_id', user.id).maybeSingle();
    if (!call) return res.status(404).json({ error: 'Call not found' });
    if (!call.recording_url) return res.status(400).json({ error: 'No recording saved for this call' });
    // download the recording with Twilio auth
    let audio;
    try {
      const a = await fetch(call.recording_url, {
        headers: { Authorization: `Basic ${Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64')}` }
      });
      if (!a.ok) throw new Error('recording fetch ' + a.status);
      audio = Buffer.from(await a.arrayBuffer());
    } catch (e) {
      return res.status(502).json({ error: 'Could not fetch recording: ' + e.message });
    }
    // resubmit to Deepgram → its async callback hits the (now-fixed) webhook
    const rbase = process.env.TWILIO_WEBHOOK_BASE_URL
      ? process.env.TWILIO_WEBHOOK_BASE_URL.replace(/\/$/, '')
      : `https://${req.headers.host}`;
    const cb = `${rbase}/api/assemblyai-webhook?dg=1&call_sid=${encodeURIComponent(call.call_sid || '')}`;
    const dgUrl = `https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&punctuate=true&diarize=true&callback=${encodeURIComponent(cb)}`;
    let reqId;
    try {
      const dgRes = await fetch(dgUrl, {
        method: 'POST',
        headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, 'Content-Type': 'audio/mpeg' },
        body: audio
      });
      const dgData = await dgRes.json();
      reqId = dgData.request_id || dgData.requestId;
      if (!dgRes.ok || !reqId) throw new Error('Deepgram submit: ' + JSON.stringify(dgData).slice(0, 160));
    } catch (e) {
      return res.status(502).json({ error: 'Deepgram submit failed: ' + e.message });
    }
    await sb.from('calls').update({ transcript: `PENDING:dg:${reqId}` }).eq('id', call.id);
    return res.status(200).json({ ok: true, request_id: reqId });
  }

  // ── Reconcile: backfill any calls Twilio recorded today that the recording webhook
  //    didn't save (it can drop callbacks under burst dialing). Authenticated by the
  //    user's JWT (not a Twilio signature). The app calls this periodically while open,
  //    so missed calls self-heal within a couple minutes regardless of webhook flakiness.
  if (req.query.reconcile === '1') {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Not signed in' });
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: { user } = {}, error: authErr } = await sb.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ error: 'Invalid session' });
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return res.status(200).json({ inserted: 0 });

    const acct = process.env.TWILIO_ACCOUNT_SID;
    const twAuth = 'Basic ' + Buffer.from(`${acct}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const twBase = `https://api.twilio.com/2010-04-01/Accounts/${acct}`;
    const today = new Date().toISOString().slice(0, 10);
    const last10 = p => String(p || '').replace(/\D/g, '').slice(-10);
    try {
      const [recsR, callsR] = await Promise.all([
        fetch(`${twBase}/Recordings.json?DateCreated=${today}&PageSize=200`, { headers: { Authorization: twAuth } }),
        fetch(`${twBase}/Calls.json?StartTime=${today}&PageSize=300`, { headers: { Authorization: twAuth } })
      ]);
      const recs = (await recsR.json()).recordings || [];
      const calls = (await callsR.json()).calls || [];

      const toByParent = {}, callFrom = {}, callTo = {};
      for (const c of calls) {
        callFrom[c.sid] = c.from || '';
        callTo[c.sid] = c.to || '';
        if (c.direction === 'outbound-dial' && c.parent_call_sid) toByParent[c.parent_call_sid] = c.to;
      }

      // ── Count every DIAL (answered or not), not just recorded calls. Each outbound-dial
      //    leg whose parent client is THIS user is one dial. Dedup by call_sid. ──
      const { data: existingDials } = await sb.from('dials').select('call_sid').eq('user_id', user.id).gte('created_at', today);
      const haveDial = new Set((existingDials || []).map(d => d.call_sid).filter(Boolean));
      const dialRows = [];
      for (const c of calls) {
        if (c.direction !== 'outbound-dial' || !c.sid || haveDial.has(c.sid)) continue;
        const parentFrom = callFrom[c.parent_call_sid] || '';
        if (!parentFrom.startsWith('client:') || parentFrom.slice(7) !== user.id) continue;
        dialRows.push({
          user_id: user.id,
          phone: c.to || '',
          answered: (parseInt(c.duration) || 0) > 0,
          call_sid: c.sid,
          created_at: c.start_time ? new Date(c.start_time).toISOString() : new Date().toISOString()
        });
      }
      let dialsInserted = 0;
      if (dialRows.length) {
        const { error: dErr } = await sb.from('dials').insert(dialRows);
        if (dErr) console.error('reconcile dials insert error:', dErr.message);
        else dialsInserted = dialRows.length;
      }

      const { data: existing } = await sb.from('calls').select('call_sid, recording_sid, duration').eq('user_id', user.id).gte('created_at', today);
      const haveCall = new Set((existing || []).map(r => r.call_sid).filter(Boolean));
      const haveRec = new Set((existing || []).map(r => r.recording_sid).filter(Boolean));
      const durByRec = {};
      for (const r of (existing || [])) { if (r.recording_sid) durByRec[r.recording_sid] = r.duration; }
      const { data: prof } = await sb.from('profiles').select('twilio_phone_number').eq('id', user.id).single();
      const fromNum = prof?.twilio_phone_number || '';
      const { data: contacts } = await sb.from('contacts').select('id, phone').eq('user_id', user.id).not('phone', 'is', null);
      const cmap = {};
      for (const c of (contacts || [])) { const k = last10(c.phone); if (k) cmap[k] = c.id; }

      const rows = [];
      const durFixes = [];
      for (const r of recs) {
        const realDur = parseInt(r.duration) || 0;   // the recording resource's duration is authoritative
        if (haveCall.has(r.call_sid) || haveRec.has(r.sid)) {
          // Already saved — but the webhook's RecordingDuration callback is unreliable
          // (can be -1 for dual-channel), so heal the stored duration from the real one.
          if (haveRec.has(r.sid) && realDur > 0 && durByRec[r.sid] !== realDur) durFixes.push({ rsid: r.sid, dur: realDur });
          continue;
        }
        // Attribute each recording to the user who actually placed/received it, so a
        // shared Twilio account never leaks one user's calls into another's log.
        const legFrom = callFrom[r.call_sid] || '';
        let to;
        if (legFrom.startsWith('client:')) {
          if (legFrom.slice(7) !== user.id) continue;       // another user's outbound call
          to = toByParent[r.call_sid] || '';
        } else if (fromNum && last10(callTo[r.call_sid]) === last10(fromNum)) {
          to = legFrom;                                      // inbound to this user's number; contact = the caller
        } else {
          continue;                                          // not this user's call
        }
        rows.push({
          call_sid: r.call_sid, recording_sid: r.sid,
          recording_url: `${twBase}/Recordings/${r.sid}.mp3`,
          from_number: fromNum, to_number: to,
          duration: realDur,
          transcript: 'PENDING:unknown', notes: '',
          heat_score: null, sentiment: null, next_step: '',
          contact_id: cmap[last10(to)] || null, user_id: user.id,
          created_at: r.date_created ? new Date(r.date_created).toISOString() : new Date().toISOString()
        });
      }
      for (const f of durFixes) {
        await sb.from('calls').update({ duration: f.dur }).eq('recording_sid', f.rsid).eq('user_id', user.id);
      }
      if (rows.length) {
        const { error: insErr } = await sb.from('calls').insert(rows);
        if (insErr) { console.error('reconcile insert error:', insErr); return res.status(200).json({ inserted: 0 }); }
      }
      return res.status(200).json({ inserted: rows.length, dials: dialsInserted, fixed: durFixes.length });
    } catch (e) {
      console.error('reconcile error:', e.message);
      return res.status(200).json({ inserted: 0 });
    }
  }

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

  const recordingBase = process.env.TWILIO_WEBHOOK_BASE_URL
    ? process.env.TWILIO_WEBHOOK_BASE_URL.replace(/\/$/, '')
    : `https://${req.headers.host}`;
  const audioUrl = `${RecordingUrl}.mp3`;

  // Save the call row FIRST — BEFORE the slow work (downloading the recording and
  // starting transcription). Under burst dialing those steps can run several seconds
  // each and the function can time out; doing them before the insert meant the whole
  // call was silently lost. Now the row always lands; we patch in the transcript
  // pointer afterward. If the function dies mid-transcription, the row still exists
  // with the recording and is recoverable via Re-transcribe.
  let callRowId = null;
  try {
    const { data: inserted, error: insertErr } = await supabase.from('calls').insert({
      call_sid: CallSid,
      recording_sid: RecordingSid,
      recording_url: audioUrl,
      from_number: From,
      to_number: To,
      duration: Math.max(0, parseInt(RecordingDuration) || 0),
      transcript: 'PENDING:unknown',
      notes: '',
      heat_score: null,
      sentiment: null,
      next_step: '',
      contact_id: null,
      user_id: userId
    }).select('id').single();
    if (insertErr) console.error('Call insert error:', insertErr);
    else callRowId = inserted?.id || null;
  } catch (dbErr) {
    console.error('DB insert error:', dbErr);
  }

  let transcriptPlaceholder = 'PENDING:unknown';
  let transcriptId = null;

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

  // Patch the transcript pointer onto the row we saved up front, so the Deepgram /
  // AssemblyAI callback can find it by its PENDING:* marker. The row already exists,
  // so even if everything above this point failed, the call is not lost.
  if (callRowId) {
    try {
      await supabase.from('calls').update({
        transcript: transcriptPlaceholder,
        notes: transcriptId ? '' : 'Transcription could not be started'
      }).eq('id', callRowId);
    } catch (e) {
      console.error('transcript pointer update failed:', e.message);
    }
  }

  res.status(200).json({ status: transcriptId ? 'pending' : 'saved_no_transcript', transcriptId });
}
