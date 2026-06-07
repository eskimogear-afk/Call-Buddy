import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const SYSTEM_PROMPT = 'You are an expert sales call analyst for mortgage professionals. Be precise and return only valid JSON.';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { transcript_id, status } = req.body || {};
  if (!transcript_id) return res.status(400).json({ error: 'No transcript_id' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  if (status === 'error') {
    await supabase.from('calls')
      .update({ transcript: 'ERROR: Transcription failed', notes: 'Transcription failed' })
      .eq('transcript', `PENDING:${transcript_id}`);
    return res.status(200).json({ ok: true });
  }

  if (status !== 'completed') return res.status(200).json({ status: 'ignored' });

  try {
    const r = await fetch(`https://api.assemblyai.com/v2/transcript/${transcript_id}`, {
      headers: { Authorization: process.env.ASSEMBLYAI_API_KEY }
    });
    const data = await r.json();
    const transcriptText = data.text || '';

    const { data: callRecord } = await supabase
      .from('calls')
      .select('to_number, from_number, user_id')
      .eq('transcript', `PENDING:${transcript_id}`)
      .single();

    if (!transcriptText) {
      await supabase.from('calls')
        .update({ transcript: '', notes: 'No speech detected' })
        .eq('transcript', `PENDING:${transcript_id}`);
      return res.status(200).json({ status: 'no_speech' });
    }

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{
        role: 'user',
        content: `Analyze this cold call transcript. Return ONLY valid JSON with keys: "name" (prospect full name or "Unknown"), "company" (or ""), "notes" (2-3 sentence summary), "heatScore" (one of exactly: Hot, Warm, Cold), "sentiment" (one of: positive, neutral, negative), "nextStep" (brief next action or "").

Transcript:
${transcriptText}`
      }]
    });

    let analysis = { notes: '', heatScore: 'Cold', sentiment: 'neutral', nextStep: '' };
    const text = message.content.map(b => b.text || '').join('').trim();
    try {
      analysis = JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch {
      analysis.notes = transcriptText.slice(0, 300);
    }

    const phone = callRecord?.to_number || callRecord?.from_number || 'unknown';
    const userId = callRecord?.user_id || null;

    const { data: contact } = await supabase
      .from('contacts')
      .upsert({
        phone,
        user_id: userId,
        name: analysis.name && analysis.name !== 'Unknown' ? analysis.name : 'Unknown',
        company: analysis.company || '',
        heat_score: analysis.heatScore || 'Cold',
        last_called: new Date().toISOString()
      }, { onConflict: 'phone,user_id' })
      .select()
      .single();

    await supabase.from('calls')
      .update({
        transcript: transcriptText,
        notes: analysis.notes || '',
        heat_score: analysis.heatScore || 'Cold',
        sentiment: analysis.sentiment || 'neutral',
        next_step: analysis.nextStep || '',
        contact_id: contact?.id || null
      })
      .eq('transcript', `PENDING:${transcript_id}`);

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('AssemblyAI webhook error:', err);
    res.status(500).json({ error: String(err) });
  }
}
