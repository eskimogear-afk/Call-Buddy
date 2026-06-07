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

  const { transcript, type, name, summary, painPoints, nextSteps } = req.body || {};

  let prompt = '';
  if (type === 'email') {
    prompt = `Write a short, friendly, personalized follow-up email from a sales professional to a prospect after a cold call.
Name: ${name || 'the prospect'}
Call summary: ${summary || ''}
Pain points discussed: ${painPoints || ''}
Next steps agreed: ${nextSteps || ''}
Keep it under 150 words. Conversational, not salesy. End with one clear call to action.
Return ONLY the email body - no subject line, no JSON, no extra formatting.`;
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

    if (type === 'email') {
      return res.status(200).json({ result: text });
    } else {
      const clean = text.replace(/```json|```/g, '').trim();
      return res.status(200).json(JSON.parse(clean));
    }
  } catch (err) {
    console.error('Analyze error:', err);
    return res.status(500).json({ error: err.message || 'Analysis failed' });
  }
}
