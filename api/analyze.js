import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const ALLOWED_ORIGIN = 'https://call-buddy-omega.vercel.app';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return res.status(500).json({ error: 'Supabase not configured' });

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Unauthorized' });

  const { transcript, type, name, summary, painPoints, nextSteps, call_id } = req.body || {};

  let prompt = '';
  if (type === 'next_action') {
    // AI picks the best next move (in-person / meeting / call / text) from the call
    if (!call_id) return res.status(400).json({ error: 'call_id required' });
    const { data: call } = await supabase
      .from('calls')
      .select('id, transcript, notes, next_step, heat_score, contacts(id, name, phone, company)')
      .eq('id', call_id).eq('user_id', user.id).single();
    if (!call) return res.status(404).json({ error: 'Call not found' });
    const naTranscript = String(call.transcript || '').startsWith('PENDING:') ? '' : (call.transcript || '');
    req._naContact = call.contacts || null;
    req._naCallId = call.id;

    prompt = `You are a sales strategist for a mortgage loan officer. Based on this call, decide the SINGLE best next action to move the relationship forward, choosing between: "in_person" (meet face to face), "meeting" (video meeting / Google Meet), "call" (phone call), "sms" (text message).

Decision guidance: honor anything explicitly agreed on the call first (that wins). Otherwise weigh warmth and stakes — hot leads with concrete deals justify in-person or a video meeting; lukewarm or early relationships fit a call; light touches or confirmations fit a text. Use business hours, America/New_York timezone. Current datetime: ${new Date().toISOString()}.

Prospect: ${call.contacts?.name || 'unknown'}${call.contacts?.company ? ' (' + call.contacts.company + ')' : ''} · heat: ${call.heat_score || 'unknown'}
AI call notes: ${call.notes || ''}
Stated next step: ${call.next_step || ''}

Return ONLY valid JSON:
{
 "type": "in_person" | "meeting" | "call" | "sms",
 "reason": 1-2 sentences on why this action beats the alternatives for this prospect,
 "datetime": ISO 8601 with -04:00 offset (use any agreed timing from the call, else next sensible business slot),
 "duration_minutes": 15 | 30 | 60 (omit for sms),
 "title": short imperative, e.g. "Video demo of investor programs with Liliana",
 "message": if sms, the exact friendly text to send; otherwise a 1-2 sentence agenda/description,
 "location": for in_person only — a sensible suggestion grounded in the call (their office, our Altamonte Springs branch, a coffee spot near them) or "" if unknown,
 "prep": array of 2-3 short talking points to prepare, grounded in what was discussed
}

Transcript:
${naTranscript || '(no transcript — base it on the notes and next step above)'}`;
  } else if (type === 'email') {
    // Pull the call + contact server-side so the draft is grounded in the real transcript
    let emailTranscript = transcript || '';
    let emailNotes = summary || '';
    let emailNext = nextSteps || '';
    let recipientName = name || '';
    let recipientEmail = '';
    if (call_id) {
      const { data: call } = await supabase
        .from('calls')
        .select('transcript, notes, next_step, contacts(name, email)')
        .eq('id', call_id).eq('user_id', user.id).single();
      if (call) {
        if (!String(call.transcript || '').startsWith('PENDING:')) emailTranscript = call.transcript || emailTranscript;
        emailNotes = call.notes || emailNotes;
        emailNext = call.next_step || emailNext;
        recipientName = call.contacts?.name && call.contacts.name !== 'Unknown' ? call.contacts.name : recipientName;
        recipientEmail = call.contacts?.email || '';
      }
    }
    // Sender hint from profile
    const { data: prof } = await supabase.from('profiles').select('full_name').eq('id', user.id).single();
    const senderName = prof?.full_name || '';

    prompt = `You are drafting a follow-up email a mortgage loan officer will send to a real estate agent (or prospect) right after a phone call. Base it ENTIRELY on what was actually discussed in the transcript — names, programs, the agreed next step, timing — do not invent facts.

Sender (loan officer): ${senderName || 'infer from the transcript'}
Recipient: ${recipientName || 'the person called'}
AI call summary: ${emailNotes}
Agreed next step: ${emailNext}

Guidelines:
- Warm, professional, concise (120-180 words). Not pushy.
- Open by referencing the actual conversation.
- Recap only the specific value points that came up on the call.
- Restate the agreed next step and timing clearly.
- Sign with the sender's name and company if mentioned in the transcript.

Return ONLY valid JSON: {"subject": "...", "body": "..."} — body uses \\n for line breaks, no markdown.

Transcript:
${emailTranscript || '(no transcript available — write a brief, generic but warm follow-up based on the summary and next step above)'}`;
    // stash recipient email to return after the model call
    req._recipientEmail = recipientEmail;
  } else {
    if (!transcript) return res.status(400).json({ error: 'No transcript provided' });
    prompt = `You are an AI assistant for a sales professional. Analyze this cold call transcript and return ONLY valid JSON with these exact keys:
"summary": 2-3 sentence summary of the call,
"name": prospect full name if mentioned else "",
"company": company or employer if mentioned else "",
"phone": phone number if mentioned else "",
"email": email address if mentioned else "",
"address": property or home address if mentioned else "",
"outcome": one of exactly: Interested, Not interested, Callback, Voicemail, No answer,
"followUpDate": YYYY-MM-DD if a specific date was agreed else "",
"painPoints": 1-2 sentences on the prospect concerns or situation,
"nextSteps": 1-2 sentences on what was agreed as the next action,
"heatScore": one of exactly: Hot, Warm, Cold based on prospect engagement and interest.
Return ONLY the JSON object. No markdown. No explanation.
Transcript:
${transcript}`;
  }

  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: [{ type: 'text', text: 'You are an expert sales call analyst for mortgage professionals. Be precise and concise.', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: prompt }]
    });

    const text = message.content.map(b => b.text || '').join('').trim();

    if (type === 'next_action') {
      let rec;
      try {
        rec = JSON.parse(text.replace(/```json|```/g, '').trim());
      } catch {
        return res.status(500).json({ error: 'Could not parse recommendation' });
      }
      const validTypes = ['in_person', 'meeting', 'call', 'sms'];
      if (!validTypes.includes(rec.type)) rec.type = 'call';
      const d = new Date(rec.datetime);
      rec.datetime = (!isNaN(d.getTime()) && d.getTime() > Date.now() - 60000)
        ? d.toISOString()
        : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      rec.prep = Array.isArray(rec.prep) ? rec.prep.slice(0, 4) : [];
      return res.status(200).json({
        ...rec,
        contact: req._naContact ? { id: req._naContact.id, name: req._naContact.name, phone: req._naContact.phone, company: req._naContact.company } : null,
        call_id: req._naCallId
      });
    } else if (type === 'email') {
      let subject = '', body = text;
      try {
        const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
        subject = parsed.subject || '';
        body = parsed.body || text;
      } catch {
        // Model returned plain text — use as body, derive a simple subject
        subject = 'Following up on our call';
      }
      return res.status(200).json({ subject, body, to: req._recipientEmail || '' });
    } else {
      const clean = text.replace(/```json|```/g, '').trim();
      return res.status(200).json(JSON.parse(clean));
    }
  } catch (err) {
    console.error('Analyze error:', err);
    return res.status(500).json({ error: err.message || 'Analysis failed' });
  }
}
