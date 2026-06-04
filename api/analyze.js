const https = require('https');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = '';
  await new Promise((resolve, reject) => {
    req.on('data', chunk => body += chunk);
    req.on('end', resolve);
    req.on('error', reject);
  });

  let parsed;
  try { parsed = JSON.parse(body); } 
  catch(e) { return res.status(400).json({ error: 'Invalid JSON' }); }

  const { transcript, type, name, summary, painPoints, nextSteps } = parsed;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

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

  const requestBody = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }]
  });

  return new Promise((resolve) => {
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestBody),
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      }
    };

    const apiReq = https.request(options, (apiRes) => {
      let data = '';
      apiRes.on('data', chunk => data += chunk);
      apiRes.on('end', () => {
        try {
          const json = JSON.parse(data);
          const text = (json.content || []).map(b => b.text || '').join('').trim();
          if (type === 'email') {
            res.status(200).json({ result: text });
          } else {
            const clean = text.replace(/```json|```/g, '').trim();
            const parsed = JSON.parse(clean);
            res.status(200).json(parsed);
          }
        } catch(e) {
          res.status(500).json({ error: 'Parse error: ' + e.message, raw: data.slice(0, 200) });
        }
        resolve();
      });
    });

    apiReq.on('error', (e) => {
      res.status(500).json({ error: 'API request failed: ' + e.message });
      resolve();
    });

    apiReq.write(requestBody);
    apiReq.end();
  });
};
