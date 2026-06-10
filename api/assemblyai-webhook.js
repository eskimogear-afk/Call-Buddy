import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const SYSTEM_PROMPT = 'You are an expert sales call analyst for mortgage professionals. Be precise and return only valid JSON.';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY)
    return res.status(500).json({ error: 'Supabase not configured' });
  if (!process.env.ASSEMBLYAI_API_KEY)
    return res.status(500).json({ error: 'ASSEMBLYAI_API_KEY not configured' });

  console.log('AAI webhook body:', JSON.stringify(req.body || {}).slice(0, 300));
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
    // Fetch transcript from AssemblyAI
    const aaiRes = await fetch(`https://api.assemblyai.com/v2/transcript/${transcript_id}`, {
      headers: { Authorization: process.env.ASSEMBLYAI_API_KEY }
    });
    const aaiData = await aaiRes.json();
    const transcriptText = aaiData.text || '';

    // Find the matching call record
    const { data: callRecord } = await supabase
      .from('calls')
      .select('id, to_number, from_number, user_id')
      .eq('transcript', `PENDING:${transcript_id}`)
      .single();

    if (!transcriptText) {
      await supabase.from('calls')
        .update({ transcript: '', notes: 'No speech detected' })
        .eq('transcript', `PENDING:${transcript_id}`);
      return res.status(200).json({ status: 'no_speech' });
    }

    // Analyse with Claude
    let analysis = { name: 'Unknown', company: '', notes: '', heatScore: 'Cold', sentiment: 'neutral', nextStep: '' };

    if (process.env.ANTHROPIC_API_KEY) {
      try {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const aiResponse = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 1024,
          system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
          messages: [{
            role: 'user',
            content: `Analyze this cold call transcript. Return ONLY valid JSON with keys:
"name" (prospect full name or "Unknown"), "company" (or ""), "notes" (2-3 sentence summary), "heatScore" (one of exactly: Hot, Warm, Cold), "sentiment" (one of: positive, neutral, negative), "nextStep" (brief next action or ""),
"followUp": an object describing the concrete follow-up activity implied by the call, or {"needed": false} if none is warranted. When needed, include:
  "needed": true,
  "type": one of exactly "call", "sms", "meeting", "task",
  "datetime": ISO 8601 datetime WITH timezone offset for when it should happen. Current datetime is ${new Date().toISOString()} and the user's timezone is America/New_York (offset -04:00). If a specific day/time was agreed on the call, use it (interpret relative dates like "Monday" or "next week" from the current date, business hours, default 10:00 AM if no time given). If nothing specific was agreed but a follow-up makes sense, pick the next business day at 10:00 AM.
  "title": short imperative summary, e.g. "Call Liliana to confirm Wednesday demo",
  "message": if type is "sms", the exact friendly text message to send; otherwise a 1-sentence description of what to do.

Transcript:
${transcriptText}`
          }]
        });

        const rawText = aiResponse.content.map(b => b.text || '').join('').trim();
        try {
          analysis = JSON.parse(rawText.replace(/```json|```/g, '').trim());
        } catch {
          analysis.notes = transcriptText.slice(0, 300);
        }
      } catch (aiErr) {
        console.error('Claude analysis error:', aiErr);
        analysis.notes = transcriptText.slice(0, 300);
      }
    } else {
      console.warn('ANTHROPIC_API_KEY not set — skipping AI analysis');
      analysis.notes = transcriptText.slice(0, 300);
    }

    const phone = callRecord?.to_number || callRecord?.from_number || null;
    const userId = callRecord?.user_id || null;

    // Upsert contact — only if we have a valid phone and user
    let contact = null;
    if (phone && userId) {
      const { data: upsertedContact, error: upsertErr } = await supabase
        .from('contacts')
        .upsert({
          phone,
          user_id: userId,
          name: analysis.name && analysis.name !== 'Unknown' ? analysis.name : undefined,
          company: analysis.company || undefined,
          heat_score: analysis.heatScore || 'Cold',
          last_called: new Date().toISOString(),
          stage: 'contacted'
        }, {
          onConflict: 'phone,user_id',
          ignoreDuplicates: false
        })
        .select()
        .single();
      if (upsertErr) console.error('contact upsert error:', upsertErr.message);
      contact = upsertedContact;
    } else if (phone && !userId) {
      // No user_id — try to insert without conflict handling
      const { data: newContact } = await supabase
        .from('contacts')
        .insert({ phone, name: analysis.name || 'Unknown', heat_score: analysis.heatScore || 'Cold' })
        .select()
        .single();
      contact = newContact;
    }

    // Update the call record
    const { data: updatedRows, error: updateErr } = await supabase.from('calls')
      .update({
        transcript: transcriptText,
        notes: analysis.notes || '',
        heat_score: analysis.heatScore || 'Cold',
        sentiment: analysis.sentiment || 'neutral',
        next_step: analysis.nextStep || '',
        contact_id: contact?.id || null
      })
      .eq('transcript', `PENDING:${transcript_id}`)
      .select('id');
    console.log('calls update:', JSON.stringify({ matched: updatedRows?.length ?? null, error: updateErr?.message || null }));

    // AI-drafted follow-up SUGGESTION — saved as status 'suggested' so nothing
    // happens until the user confirms it in the post-call popup (the cron and
    // Send-now only act on 'pending' rows)
    const fu = analysis.followUp;
    if (contact?.id && userId && fu && fu.needed) {
      const validTypes = ['call', 'sms', 'meeting', 'task'];
      const type = validTypes.includes(fu.type) ? fu.type : 'task';
      let scheduledAt;
      try {
        const d = new Date(fu.datetime);
        scheduledAt = isNaN(d.getTime()) || d.getTime() < Date.now() - 60000
          ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
          : d.toISOString();
      } catch {
        scheduledAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      }
      const { data: callRow } = await supabase.from('calls').select('id').eq('transcript', transcriptText).eq('user_id', userId).order('created_at', { ascending: false }).limit(1).single();
      await supabase.from('follow_ups').insert({
        user_id: userId,
        contact_id: contact.id,
        call_id: callRow?.id || null,
        type,
        title: String(fu.title || analysis.nextStep || 'Follow up').slice(0, 140),
        message: String(fu.message || analysis.nextStep || '').slice(0, 300),
        scheduled_at: scheduledAt,
        status: 'suggested'
      }).then(({ error }) => { if (error) console.error('Suggested follow-up insert failed:', error.message); });
    }

    res.status(200).json({ ok: true, contact: contact?.id, heatScore: analysis.heatScore });
  } catch (err) {
    console.error('AssemblyAI webhook error:', err);
    // Still return 200 so AssemblyAI doesn't retry infinitely
    res.status(200).json({ error: String(err) });
  }
}
