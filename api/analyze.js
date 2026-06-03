export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { transcript, type } = req.body || {};
  if (!transcript) return res.status(400).json({ error: 'No transcript provided' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'API not configured' });

  try {
    let prompt = '';
    if (type === 'email') {
      const { name, summary, painPoints, nextSteps } = req.body;
      prompt = `Write a short, friendly, personalized follow-up email from a sales professional to a prospect after a cold call.
Name: ${name || 'the prospect'}
Call summary: ${summary || ''}
Pain points discussed: ${painPoints || ''}
Next steps agreed: ${nextSteps || ''}
Keep it under 150 words. Conversational, not salesy. End with a clear single call to action.
Return ONLY the email body text - no subject line, no JSON, no formatting markers.`;
    } else {
      prompt = `You are an AI assistant for a sales professional. Analyze this cold call transcript and return ONLY valid JSON with these exact keys:
"summary": 2-3 sentence plain-English summary of the call,
"name": prospect full name if mentioned else "",
"company": company or employer if mentioned else "",
"phone": phone number if mentioned else "",
"email": email if mentioned else "",
"address": property address if mentioned else "",
"outcome": one of exactly: Interested, Not interested, Callback, Voicemail, No answer,
"followUpDate": YYYY-MM-DD if a specific date was mentioned else "",
"painPoints": 1-2 sentences on the prospect concerns or situation,
"nextSteps": 1-2 sentences on what was agreed as the next action,
"heatScore": one of exactly: Hot, Warm, Cold based on the prospect engagement and interest level.
Return ONLY JSON. No markdown. No preamble. No explanation.
Transcript:\n${transcript}`;
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    const text = data.content?.map(b => b.text || '').join('').trim();

    if (type === 'email') {
      return res.status(200).json({ result: text });
    } else {
      const clean = text.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(clean);
      return res.status(200).json(parsed);
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
