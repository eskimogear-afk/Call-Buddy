import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const ALLOWED_ORIGIN = 'https://call-buddy-omega.vercel.app';

// Area code → likely metro. Anchors the AI city guess (esp. FL/TX markets) and
// is the deterministic fallback if the AI call fails. Not exhaustive — the AI
// fills the long tail.
const AREA_CITY = {
  // Florida
  '305':'Miami, FL','786':'Miami, FL','954':'Fort Lauderdale, FL','754':'Fort Lauderdale, FL','561':'West Palm Beach, FL','407':'Orlando, FL','689':'Orlando, FL','321':'Orlando, FL','813':'Tampa, FL','727':'St. Petersburg, FL','941':'Sarasota, FL','239':'Fort Myers, FL','904':'Jacksonville, FL','850':'Tallahassee, FL','386':'Daytona Beach, FL','352':'Ocala, FL','863':'Lakeland, FL',
  // Texas
  '214':'Dallas, TX','469':'Dallas, TX','972':'Dallas, TX','945':'Dallas, TX','817':'Fort Worth, TX','682':'Fort Worth, TX','512':'Austin, TX','737':'Austin, TX','713':'Houston, TX','281':'Houston, TX','832':'Houston, TX','346':'Houston, TX','210':'San Antonio, TX','726':'San Antonio, TX','915':'El Paso, TX','806':'Lubbock, TX','325':'Abilene, TX','361':'Corpus Christi, TX','409':'Beaumont, TX','903':'Tyler, TX','430':'Tyler, TX','432':'Midland, TX','254':'Waco, TX','940':'Denton, TX','956':'McAllen, TX','979':'College Station, TX',
  // Major metros
  '212':'New York, NY','646':'New York, NY','332':'New York, NY','917':'New York, NY','718':'New York, NY','347':'New York, NY','929':'New York, NY',
  '213':'Los Angeles, CA','323':'Los Angeles, CA','310':'Los Angeles, CA','424':'Los Angeles, CA','818':'Los Angeles, CA','747':'Los Angeles, CA','626':'Pasadena, CA','661':'Bakersfield, CA',
  '415':'San Francisco, CA','628':'San Francisco, CA','510':'Oakland, CA','650':'San Mateo, CA','408':'San Jose, CA','669':'San Jose, CA','925':'Concord, CA','916':'Sacramento, CA','619':'San Diego, CA','858':'San Diego, CA','949':'Irvine, CA','714':'Anaheim, CA','951':'Riverside, CA','909':'San Bernardino, CA','805':'Oxnard, CA','559':'Fresno, CA',
  '312':'Chicago, IL','773':'Chicago, IL','872':'Chicago, IL','847':'Chicago, IL','630':'Chicago, IL','708':'Chicago, IL',
  '404':'Atlanta, GA','470':'Atlanta, GA','678':'Atlanta, GA','770':'Atlanta, GA',
  '206':'Seattle, WA','425':'Seattle, WA','253':'Tacoma, WA','503':'Portland, OR','971':'Portland, OR',
  '617':'Boston, MA','857':'Boston, MA','781':'Boston, MA',
  '202':'Washington, DC','703':'Arlington, VA','571':'Arlington, VA','301':'Bethesda, MD','240':'Bethesda, MD',
  '215':'Philadelphia, PA','267':'Philadelphia, PA','445':'Philadelphia, PA','412':'Pittsburgh, PA',
  '480':'Phoenix, AZ','602':'Phoenix, AZ','623':'Phoenix, AZ','520':'Tucson, AZ',
  '702':'Las Vegas, NV','725':'Las Vegas, NV','303':'Denver, CO','720':'Denver, CO','801':'Salt Lake City, UT','385':'Salt Lake City, UT',
  '612':'Minneapolis, MN','651':'St. Paul, MN','763':'Minneapolis, MN','952':'Minneapolis, MN',
  '313':'Detroit, MI','248':'Detroit, MI','734':'Ann Arbor, MI','586':'Warren, MI',
  '216':'Cleveland, OH','614':'Columbus, OH','513':'Cincinnati, OH',
  '615':'Nashville, TN','629':'Nashville, TN','901':'Memphis, TN',
  '704':'Charlotte, NC','980':'Charlotte, NC','919':'Raleigh, NC','984':'Raleigh, NC','336':'Greensboro, NC',
  '314':'St. Louis, MO','816':'Kansas City, MO','504':'New Orleans, LA','317':'Indianapolis, IN','414':'Milwaukee, WI',
};

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

  // Rate limit: cap paid-model calls per user (cost-abuse backstop).
  // Rolling 60s window; prune old rows opportunistically.
  try {
    const RPM = 25;
    const cutoff = new Date(Date.now() - 60000).toISOString();
    const { count } = await supabase.from('ai_calls')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id).gte('created_at', cutoff);
    if ((count || 0) >= RPM) {
      res.setHeader('Retry-After', '30');
      return res.status(429).json({ error: 'Too many requests — give it a moment and try again.' });
    }
    await supabase.from('ai_calls').insert({ user_id: user.id });
    if (Math.floor((Date.now() / 1000) % 10) === 0) {
      await supabase.from('ai_calls').delete().lt('created_at', new Date(Date.now() - 600000).toISOString());
    }
  } catch (e) { console.error('rate-limit check failed (allowing):', e.message); }

  const { transcript, type, name, summary, painPoints, nextSteps, call_id, phone, force, question, lo_rates, contact_id } = req.body || {};

  /* ── City suggestion: guess an agent's city from area code + AI, for human verify ── */
  if (type === 'city_suggest') {
    if (!contact_id) return res.status(400).json({ error: 'contact_id required' });
    const { data: c } = await supabase
      .from('contacts')
      .select('id, name, first_name, last_name, phone, company, brokerage, agent_type, address, city, city_suggested, city_status')
      .eq('id', contact_id).eq('user_id', user.id).single();
    if (!c) return res.status(404).json({ error: 'Contact not found' });
    if (c.city_status === 'confirmed') return res.status(200).json({ city: c.city, status: 'confirmed' });
    if (c.city_status === 'denied' && !force) return res.status(200).json({ city: null, status: 'denied' });
    if (c.city_suggested && !force) return res.status(200).json({ city: c.city_suggested, status: 'suggested', cached: true });

    const digits = String(c.phone || '').replace(/\D/g, '');
    const ten = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
    const area = ten.slice(0, 3);
    const hint = AREA_CITY[area] || '';
    const nm = c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || '';
    const ctx = [nm && ('Name: ' + nm), (c.brokerage || c.company) && ('Brokerage: ' + (c.brokerage || c.company)), c.agent_type && ('Type: ' + c.agent_type), c.address && ('Address: ' + c.address)].filter(Boolean).join('; ');
    let suggested = hint; // deterministic fallback
    if (area.length === 3) {
      try {
        const ar = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 16,
            system: 'You output ONLY a US city formatted exactly as "City, ST" (two-letter state). Never ask questions, never apologize, never explain, never add extra words. If details are sparse, use the area code\'s primary metro.',
            messages: [{ role: 'user', content: `Area code ${area}${hint ? ', primary metro ' + hint : ''}.${ctx ? ' ' + ctx + '.' : ''} Output the single most likely city as "City, ST".` }]
          })
        });
        const ad = await ar.json();
        const raw = (ad.content || []).map(b => b.text || '').join('').trim().replace(/^["']|["']$/g, '').split('\n')[0].slice(0, 60);
        // Only trust a clean "City, ST"; otherwise keep the deterministic area-code metro
        // (guards against the model occasionally replying conversationally).
        if (/^[A-Za-z][A-Za-z.'\- ]{1,28},\s*[A-Z]{2}$/.test(raw)) suggested = raw;
      } catch (e) { console.error('city_suggest AI error:', e.message); }
    }
    if (!suggested) return res.status(200).json({ city: null, status: 'unknown' });
    await supabase.from('contacts').update({ city_suggested: suggested, city_status: 'suggested' }).eq('id', c.id).eq('user_id', user.id);
    return res.status(200).json({ city: suggested, status: 'suggested' });
  }

  /* ── Prospect research: AI web-search brief on the realtor behind a number ── */
  if (type === 'research') {
    // DISABLED to conserve Anthropic credits. Prospect research is the most expensive
    // feature by far (premium model + up to 6 live web searches per prospect). This guard
    // guarantees no research call hits the API even from a stale client. To re-enable,
    // delete this single return.
    return res.status(403).json({ error: 'AI prospect research is turned off to conserve credits.' });
    if (!phone) return res.status(400).json({ error: 'phone required' });
    const digits = String(phone).replace(/\D/g, '');
    const ten = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
    const variants = [String(phone).trim(), '+1' + ten, ten, '1' + ten];

    // Find the contact (any stored phone format)
    const { data: matches } = await supabase
      .from('contacts')
      .select('id, name, first_name, last_name, company, research, researched_at')
      .eq('user_id', user.id)
      .in('phone', variants)
      .limit(1);
    const contact = matches?.[0] || null;

    // Fresh cache → return instantly (research is paid; don't re-buy it)
    if (contact?.research && contact.researched_at && !force) {
      const ageDays = (Date.now() - new Date(contact.researched_at).getTime()) / 86400000;
      if (ageDays < 30) return res.status(200).json({ cached: true, contact_id: contact.id, ...contact.research });
    }

    // Resolve a usable identity: contact name → CNAM lookup
    let personName = contact && contact.name && contact.name.toLowerCase() !== 'unknown' ? contact.name : '';
    let personCompany = contact?.company || '';
    if (!personName && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
      try {
        const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
        const lr = await fetch(`https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent('+1' + ten)}?Fields=caller_name`, { headers: { Authorization: `Basic ${auth}` } });
        if (lr.ok) {
          const ld = await lr.json();
          const cn = ld.caller_name || {};
          if (cn.caller_name && cn.caller_type !== 'BUSINESS') {
            personName = String(cn.caller_name).toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
          } else if (cn.caller_name && cn.caller_type === 'BUSINESS' && !personCompany) {
            personCompany = String(cn.caller_name).toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
          }
        }
      } catch (e) { console.error('research CNAM failed:', e.message); }
    }
    if (!personName) {
      return res.status(422).json({ error: "Couldn't identify who this number belongs to yet. Add a name to the contact (or let a call identify them) and try again." });
    }

    try {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const msg = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 3200,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }],
        system: [{ type: 'text', text: 'You are a meticulous sales-intelligence researcher for a mortgage loan officer. You only state facts your sources support and clearly mark unknowns. You always end with a single valid JSON object.', cache_control: { type: 'ephemeral' } }],
        messages: [{
          role: 'user',
          content: `Research this real estate agent using web search and produce a fact-based pre-call brief.

Agent: ${personName}${personCompany ? ' — ' + personCompany : ''} (real estate agent, likely Florida; phone area code ${ten.slice(0, 3)})

Search public sources (Zillow and realtor.com agent profiles, brokerage bios, LinkedIn, news, public social posts) and determine:
- how long they've been in business / licensed since
- approximately how many homes they've sold and current active listings
- brokerages they've worked for (current and past)
- whether they work with investors, first-time homebuyers, luxury, etc.
- what they post or talk about online: themes, recent activity — summarized
- anything useful for a mortgage loan officer proposing a referral partnership

Rules: never invent numbers — if a fact isn't supported by a source, use null or "unknown". If multiple agents share this name and you can't disambiguate with the company/area, set identity_confidence to "low" and say what you'd need.

After your research, output ONLY this JSON object (no prose before or after):
{"identity_confidence":"high"|"medium"|"low","summary":"3-4 sentence overview","years_in_business":number|null,"licensed_since":"YYYY or null","homes_sold":"e.g. '47 sales on Zillow' or null","active_listings":"e.g. '5 active' or null","brokerages":{"current":string|null,"past":[strings]},"client_focus":"investors / first-time buyers / mixed / unknown","online_presence":"2-3 sentences on what they post and themes","buyer_listing_mix":"buyer-side / listing-side / both / unknown","partnership_opener":"ONE natural opening line a loan officer could say to this specific agent to start a referral-partnership conversation — reference something real from the research","talking_points":[3-4 short strings for the call],"sources":[{"title":string,"url":string}]}`
        }]
      });

      const fullText = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      // Robust extraction: strip code fences, take the outermost {...} object.
      // The model may wrap JSON in ```json fences or add a trailing sentence,
      // so we can't require the brace to be the last character.
      const stripped = fullText.replace(/```json/gi, '').replace(/```/g, '');
      const first = stripped.indexOf('{'), last = stripped.lastIndexOf('}');
      let brief = null;
      if (first !== -1 && last > first) {
        const candidate = stripped.slice(first, last + 1);
        try { brief = JSON.parse(candidate); } catch (e) { console.error('research JSON parse failed:', e.message, '| head:', candidate.slice(0, 120)); }
      }
      if (!brief) {
        console.error('research: no parseable JSON. text head:', fullText.slice(0, 200));
        return res.status(500).json({ error: 'Research finished but the summary came back malformed — tap Refresh to retry.' });
      }
      brief.researched_name = personName;
      brief.researched_at = new Date().toISOString();

      if (contact?.id) {
        const upd = { research: brief, researched_at: brief.researched_at };
        if (brief.brokerages?.current) upd.brokerage = brief.brokerages.current;
        const mix = String(brief.buyer_listing_mix || '').toLowerCase();
        if (mix.includes('both')) upd.agent_type = 'Both';
        else if (mix.includes('buyer')) upd.agent_type = 'Buyer-side';
        else if (mix.includes('listing')) upd.agent_type = 'Listing-side';
        if (brief.homes_sold) upd.annual_transaction_volume = String(brief.homes_sold);
        await supabase.from('contacts')
          .update(upd)
          .eq('id', contact.id).eq('user_id', user.id);
      }
      return res.status(200).json({ cached: false, contact_id: contact?.id || null, ...brief });
    } catch (err) {
      console.error('Research error:', err);
      console.error('research err:', err); return res.status(500).json({ error: 'Research failed' });
    }
  }

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
  } else if (type === 'live_assist') {
    // DISABLED to conserve credits — the live co-pilot fired a model call every ~3.5s
    // during a call. Return empty so any client (incl. a stale tab) gets nothing and
    // spends nothing. Delete this return to re-enable.
    return res.status(200).json({ say_now: '', objection: null, tip: '' });
    // Real-time in-call co-pilot: reads the rolling LIVE transcript (both sides,
    // captured by the speaker mic) and tells the LO what to say next. Fast model.
    const t = String(transcript || '').trim();
    if (t.length < 12) return res.status(200).json({ say_now: '', objection: null, tip: '' });
    try {
      const ar = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 170,
          system: [{ type: 'text', text: "You are an elite mortgage loan officer's LIVE call co-pilot. You hear a call in progress and tell the LO EXACTLY what to say next: specific, confident, grounded in real mortgage knowledge. You know the programs cold: Conventional (640+ credit, as little as 3% down, PMI drops at 80% LTV), FHA (down to ~580, 3.5% down, easier qualifying but lifetime MIP), VA (eligible veterans, 0 down, no PMI), USDA (rural, 0 down), Jumbo (above conforming limits, 700+ and reserves), Bank Statement (self-employed, qualify on 12-24mo deposits not tax returns), DSCR (investors, qualify on the property's rent not personal income), Hard Money (fix-and-flip, asset-based, fast). You know rate vs APR (APR = note rate plus closing costs annualized; quote APR for transparency like the big lenders), temporary buydowns (2-1, 3-2-1), discount points, DTI and LTV. You handle objections like a closer who has heard them a thousand times. Use the LO's actual rate sheet when given. Be FAST, SPECIFIC, name the program and the number, give the exact words. Output ONLY compact JSON.", cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: (lo_rates ? ("LO's rate sheet today: " + String(lo_rates).slice(0,300) + "\\n\\n") : '') + 'LIVE call transcript (most recent words last):\n<<<' + t.slice(-900) + '>>>\n\nBased on the LATEST thing the other person said, what should the LO say RIGHT NOW? ONLY JSON: {"objection":"their concern in 2-5 words, or null","say_now":"the exact 1-2 sentences to say next: specific, name a program/rate/number when it helps, confident and natural","tip":"3-6 word coaching cue"}' }]
        })
      });
      const ad = await ar.json();
      const raw = (ad.content || []).map(b => b.text || '').join('').trim();
      let j; try { j = JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch { j = { say_now: '', objection: null, tip: '' }; }
      return res.status(200).json({
        objection: (j.objection && String(j.objection).toLowerCase() !== 'null') ? String(j.objection).slice(0, 120) : null,
        say_now: String(j.say_now || '').slice(0, 400),
        tip: String(j.tip || '').slice(0, 60)
      });
    } catch (e) {
      console.error('live_assist error:', e.message);
      return res.status(200).json({ say_now: '', objection: null, tip: '' });
    }
  } else if (type === 'funnel_estimate') {
    // Estimate meetings set / partnerships formed that live in the call notes
    // but were never logged as a calendar meeting or a stage change. Cheap model,
    // conservative counting; supplements the real funnel counts in Analytics.
    const { data: calls } = await supabase
      .from('calls')
      .select('outcome, notes, next_step')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(200);
    const rows = (calls || []).filter(c => (c.notes && c.notes.trim()) || (c.next_step && c.next_step.trim()));
    if (!rows.length) return res.status(200).json({ meetings_set: 0, partnerships: 0, note: 'Not enough call notes yet to estimate.' });
    const digest = rows.slice(0, 150).map((c, i) =>
      `${i + 1}. [${c.outcome || 'n/a'}] ${(c.notes || '').replace(/\s+/g, ' ').slice(0, 160)}${c.next_step ? ' | next: ' + c.next_step.replace(/\s+/g, ' ').slice(0, 90) : ''}`
    ).join('\n');
    try {
      const ar = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 220,
          system: [{ type: 'text', text: 'You estimate sales-funnel outcomes for a mortgage loan officer from their cold-call notes. Be conservative — only count clear, explicit signals. Output ONLY compact JSON.' }],
          messages: [{ role: 'user', content: `From these ${rows.length} call notes, estimate two things that often go unlogged:
- "meetings_set": how many calls resulted in a concrete meeting or appointment being agreed (a set time to meet, or a scheduled follow-up call at a specific time). A vague "I'll call back sometime" does NOT count.
- "partnerships": how many indicate a co-marketing, referral, or repeat-partner relationship forming with a real-estate agent.
Return ONLY JSON: {"meetings_set": <integer>, "partnerships": <integer>, "note": "<one short sentence like '~4 meetings and 1 partnership inferred from your notes'>"}.

Call notes:
${digest}` }]
        })
      });
      const ad = await ar.json();
      const raw = (ad.content || []).map(b => b.text || '').join('').trim();
      let j; try { j = JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch { j = {}; }
      const clampInt = v => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? Math.min(n, rows.length) : 0; };
      return res.status(200).json({
        meetings_set: clampInt(j.meetings_set),
        partnerships: clampInt(j.partnerships),
        note: String(j.note || '').slice(0, 140),
        sampled: rows.length
      });
    } catch (e) {
      console.error('funnel_estimate error:', e.message);
      return res.status(200).json({ meetings_set: 0, partnerships: 0, note: 'Estimate unavailable right now.' });
    }
  } else if (type === 'coach' || type === 'ask') {
    // In-call Claude coaching: auto-assessment of the call, or a free-form
    // question answered grounded in the transcript.
    if (!call_id) return res.status(400).json({ error: 'call_id required' });
    const { data: call } = await supabase
      .from('calls')
      .select('id, transcript, notes, coaching, contacts(name, company, brokerage, agent_type, current_lender)')
      .eq('id', call_id).eq('user_id', user.id).single();
    if (!call) return res.status(404).json({ error: 'Call not found' });
    const t = String(call.transcript || '');
    const haveTranscript = t.trim() && !t.startsWith('PENDING:');
    const ctx = haveTranscript ? t.trim() : (call.notes || '');
    if (!ctx) return res.status(400).json({ error: 'No transcript or notes on this call yet' });
    const c = call.contacts || {};
    const who = [c.name && c.name !== 'Unknown' ? c.name : null, c.brokerage || c.company, c.agent_type ? c.agent_type + ' agent' : null, c.current_lender ? 'currently uses ' + c.current_lender : null].filter(Boolean).join(' · ');

    if (type === 'ask') {
      const q = String(question || '').trim().slice(0, 600);
      if (!q) return res.status(400).json({ error: 'question required' });
      req._coachMode = 'ask';
      prompt = `You are an expert mortgage sales coach and loan-program advisor helping a loan officer right after a call. Answer their question using ONLY what the transcript supports plus general mortgage/sales expertise. Be specific, concise, and practical. If they ask about loan programs, recommend specific program types (Conventional, FHA, VA, jumbo, bank-statement, DSCR, hard money) and WHY, based on what the prospect said. If the transcript doesn't contain something, say so rather than inventing it.

${who ? 'Who they called: ' + who + '\n' : ''}Call transcript/notes:
"""${ctx.slice(0, 25000)}"""

Loan officer's question: ${q}

Answer in plain text (no markdown headers), 2-5 short paragraphs or a tight bulleted list. Talk directly to the LO ("you").`;
    } else {
      if (call.coaching && !force) return res.status(200).json({ cached: true, ...call.coaching });
      req._coachMode = 'coach';
      req._coachCallId = call.id;
      prompt = `You are an expert mortgage sales coach reviewing a loan officer's call. Be honest, specific, and constructive — like a great manager doing a call review. Base everything on the transcript; do not invent facts.

${who ? 'Who they called: ' + who + '\n' : ''}Call transcript/notes:
"""${ctx.slice(0, 25000)}"""

Return ONLY valid JSON:
{"score": number 1-10 for how the call went,
 "headline": "one-sentence read on the call",
 "did_well": ["2-4 specific things the LO did well — quote/paraphrase real moments"],
 "improve": ["2-4 specific, constructive things to do better next time — concrete, not generic"],
 "loan_programs": ["1-3 loan program ideas that fit what the prospect described, each with a short why, or [] if not a borrower/unclear"],
 "next_move": "the single highest-value next action"}`;
    }
  } else if (type === 'quote_params') {
    // Pull mortgage pricing inputs out of what was actually said on a call
    if (!call_id) return res.status(400).json({ error: 'call_id required' });
    const { data: call } = await supabase
      .from('calls')
      .select('id, transcript, notes, quote_params')
      .eq('id', call_id).eq('user_id', user.id).single();
    if (!call) return res.status(404).json({ error: 'Call not found' });
    if (call.quote_params && !force) return res.status(200).json({ cached: true, ...call.quote_params });
    const t = String(call.transcript || '');
    if (t.startsWith('PENDING:')) return res.status(400).json({ error: 'Transcript still processing — try again in a minute' });
    if (!t.trim() && !call.notes) return res.status(400).json({ error: 'No transcript on this call to read numbers from' });
    req._qpCallId = call.id;
    prompt = `You are extracting mortgage pricing inputs from a phone call between a loan officer and a prospect. Extract ONLY figures that were actually said or directly implied in conversation (e.g. "we owe about three forty" = 340000, "putting twenty percent down" = 20). NEVER invent, assume, or fill in typical values.

Transcript:
"""${(t.trim() || call.notes).slice(0, 30000)}"""

Return ONLY valid JSON (null for anything not discussed):
{"purpose":"purchase"|"refi"|"cashout"|null,
 "program":"conventional"|"fha"|"va"|"jumbo"|"bank_stmt"|"dscr"|"hard_money"|null,
 "price":number|null,
 "down_pct":number|null,"down_amount":number|null,
 "loan_amount":number|null,"current_balance":number|null,"cash_out":number|null,
 "rate":number|null,
 "term_years":number|null,"hoa_mo":number|null,
 "confidence":"high"|"medium"|"low",
 "mentions":["up to 4 short verbatim fragments where the numbers were said"]}

Notes: "purpose" is refi for a rate/term refinance, cashout only if pulling cash out was discussed. "price" is the purchase price, or the home's value on a refi. "rate" only if a specific interest rate was discussed. Confidence is low when figures are vague or contradictory.`;
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
"heatScore": one of exactly: Hot, Warm, Cold based on prospect engagement and interest,
"sentiment": one of exactly: positive, neutral, negative — the overall tone of the conversation.
Return ONLY the JSON object. No markdown. No explanation.
Transcript:
${transcript}`;
  }

  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await anthropic.messages.create({
      // Premium model only for the quality-sensitive, customer-facing outputs (coaching
      // read + email drafts); everything else (extraction/utility) uses the cheap model.
      model: ['coach', 'email'].includes(type) ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001',
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
    } else if (type === 'ask') {
      return res.status(200).json({ answer: text.replace(/```/g, '').trim() });
    } else if (type === 'coach') {
      let j;
      try { j = JSON.parse(text.replace(/```json|```/g, '').trim()); }
      catch { console.error('coach parse err'); return res.status(500).json({ error: 'Could not generate the coaching read — try again' }); }
      const arr = v => Array.isArray(v) ? v.map(String).slice(0, 5) : [];
      const clean = {
        score: (typeof j.score === 'number' && j.score >= 0 && j.score <= 10) ? Math.round(j.score) : null,
        headline: String(j.headline || '').slice(0, 300),
        did_well: arr(j.did_well), improve: arr(j.improve),
        loan_programs: arr(j.loan_programs), next_move: String(j.next_move || '').slice(0, 300),
        generated_at: new Date().toISOString()
      };
      if (req._coachCallId) await supabase.from('calls').update({ coaching: clean }).eq('id', req._coachCallId).eq('user_id', user.id);
      return res.status(200).json({ cached: false, ...clean });
    } else if (type === 'quote_params') {
      let qp;
      try {
        qp = JSON.parse(text.replace(/```json|```/g, '').trim());
      } catch {
        return res.status(500).json({ error: 'Could not parse the numbers from this call — try again' });
      }
      const num = v => (typeof v === 'number' && isFinite(v) && v >= 0) ? v : null;
      const clean = {
        purpose: ['purchase', 'refi', 'cashout'].includes(qp.purpose) ? qp.purpose : null,
        program: ['conventional', 'fha', 'va', 'jumbo', 'bank_stmt', 'dscr', 'hard_money'].includes(qp.program) ? qp.program : null,
        price: num(qp.price), down_pct: num(qp.down_pct), down_amount: num(qp.down_amount),
        loan_amount: num(qp.loan_amount), current_balance: num(qp.current_balance), cash_out: num(qp.cash_out),
        rate: (num(qp.rate) && qp.rate > 0 && qp.rate < 20) ? qp.rate : null,
        term_years: num(qp.term_years), hoa_mo: num(qp.hoa_mo),
        confidence: ['high', 'medium', 'low'].includes(qp.confidence) ? qp.confidence : 'low',
        mentions: Array.isArray(qp.mentions) ? qp.mentions.slice(0, 4).map(String) : [],
        extracted_at: new Date().toISOString()
      };
      if (req._qpCallId) {
        await supabase.from('calls').update({ quote_params: clean }).eq('id', req._qpCallId).eq('user_id', user.id);
      }
      return res.status(200).json({ cached: false, ...clean });
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
    // Tell apart "the AI service itself is unavailable" (out of credits, rate-limited,
    // overloaded, or a key problem) from an actual bug, so the UI shows something legible
    // instead of a blank "analysis failed". The credit-balance error comes back as a 400
    // whose message contains "credit balance", so match on the message too — not just status.
    const status = err && (err.status || err.statusCode);
    const m = String((err && (err.message || (err.error && err.error.message))) || '').toLowerCase();
    const unavailable =
      status === 429 || status === 529 || status === 401 || status === 403 ||
      /credit balance|too low|quota|rate.?limit|overloaded|insufficient|billing|payment required/.test(m);
    if (unavailable) {
      return res.status(503).json({ error: 'AI is temporarily unavailable — please try again shortly.', code: 'ai_unavailable' });
    }
    return res.status(500).json({ error: 'Analysis failed' });
  }
}
