import twilio from 'twilio';
import { createClient } from '@supabase/supabase-js';

const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');

  if (req.method === 'GET') {
    return res.status(200).send('<Response><Say>PitchLog is connected.</Say></Response>');
  }

  if (req.method !== 'POST') {
    return res.status(405).send('<Response></Response>');
  }

  // Validate Twilio signature against the URL exactly as requested — req.url preserves
  // the original encoding (Twilio normalizes %3A back to ':' etc., so rebuilding the
  // query string with URLSearchParams produces a different string and fails validation)
  const twilioSignature = req.headers['x-twilio-signature'] || '';
  const baseUrl = process.env.TWILIO_WEBHOOK_BASE_URL
    ? process.env.TWILIO_WEBHOOK_BASE_URL.replace(/\/$/, '')
    : `https://${req.headers.host}`;
  const webhookUrl = `${baseUrl}${req.url}`;

  if (process.env.TWILIO_AUTH_TOKEN) {
    const valid = twilio.validateRequest(
      process.env.TWILIO_AUTH_TOKEN,
      twilioSignature,
      webhookUrl,
      req.body || {}
    );
    if (!valid) {
      console.error('Sig validation failed. Expected URL:', webhookUrl, 'Sig:', twilioSignature);
      return res.status(403).send('<Response><Say>Forbidden</Say></Response>');
    }
  }

  // Disclosure whisper for the called party (child leg of an outbound dial)
  if (req.query.disclosure === '1') {
    return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?>\n<Response><Say voice="Polly.Joanna">This call may be recorded.</Say></Response>');
  }

  // ── AI receptionist: conversational lead intake on missed inbound calls ──
  if (req.query.agent) {
    return handleAgentTurn(req, res);
  }

  const { To, From, DialCallStatus } = req.body;
  const isClientCall = (From || '').startsWith('client:');

  const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    : null;

  /* ── INBOUND: someone calling one of our Twilio numbers ────────────────── */
  if (!isClientCall) {
    // Which user owns the number that was called?
    let ownerId = null;
    let ownerName = '';
    let ownerAgent = false;
    if (supabase && To) {
      try {
        const { data: owner } = await supabase
          .from('profiles')
          .select('id, full_name, ai_receptionist')
          .eq('twilio_phone_number', To)
          .single();
        ownerId = owner?.id || null;
        ownerName = owner?.full_name || '';
        ownerAgent = owner?.ai_receptionist === true;
      } catch (e) {
        console.error('Inbound owner lookup error:', e);
      }
    }

    // Contact phone for the call log is the CALLER on inbound — pass it as "to"
    // so the recording pipeline upserts the right contact
    const cbParams = new URLSearchParams({
      user_id: ownerId || '',
      to: From || '',
      from: To || ''
    });
    const recordingCallback = xmlEscape(`${baseUrl}/api/twilio-recording?${cbParams.toString()}`);

    // Second leg: browser didn't answer (or finished) — action callback after <Dial>
    if (req.query.fallback === '1') {
      if (DialCallStatus === 'completed') {
        return res.status(200).send('<Response><Hangup/></Response>');
      }

      // Missed-call text-back: fire an SMS to the caller (real numbers only).
      // Skipped when the AI receptionist will answer — it gets the info live,
      // and the blocking Twilio API roundtrip would delay the greeting.
      const missedUserId = req.query.user_id || ownerId;
      if (!ownerAgent && missedUserId && From && /^\+\d{10,15}$/.test(From) && To &&
          process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
        try {
          // Don't double-text the same caller within 24h
          const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          const { data: recent } = await supabase.from('messages')
            .select('id')
            .eq('user_id', missedUserId)
            .eq('phone', From)
            .eq('direction', 'outbound')
            .gte('created_at', since)
            .limit(1);

          if (!recent?.length) {
            const firstName = (ownerName || '').split(/\s+/)[0];
            const txt = `Sorry I missed your call${firstName ? ` — this is ${firstName}` : ''}! What's the best time to reach you?`;
            const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
            const sms = await client.messages.create({ body: txt, from: To, to: From });

            const { data: contact } = await supabase.from('contacts')
              .select('id').eq('user_id', missedUserId).eq('phone', From).maybeSingle();
            await supabase.from('messages').insert({
              user_id: missedUserId, contact_id: contact?.id || null, phone: From,
              direction: 'outbound', body: txt, twilio_sid: sms.sid, read: true
            });
          }
        } catch (e) {
          console.error('Missed-call text-back error:', e);
        }
      }

      // AI receptionist takes the call instead of voicemail when enabled
      if (ownerAgent && missedUserId && supabase) {
        const callSid = req.body.CallSid || '';
        try {
          await supabase.from('agent_sessions').upsert({ call_sid: callSid, user_id: missedUserId, caller: From || '', history: [] });
        } catch (e) { console.error('agent session create failed:', e); }
        const firstName = (ownerName || '').split(/\s+/)[0] || 'the loan officer';
        const intro = `Hi! You've reached ${firstName}'s line — he can't pick up right this second. I'm his automated assistant, and I can make sure he calls you back ready to help. Can I start with your name?`;
        return res.status(200).send(agentGatherTwiML(baseUrl, missedUserId, From || '', ownerName, intro));
      }

      const greeting = ownerName
        ? `You have reached ${xmlEscape(ownerName)}. Please leave a message after the tone.`
        : 'Please leave a message after the tone.';
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${greeting}</Say>
  <Record maxLength="120" playBeep="true"
          recordingStatusCallback="${recordingCallback}"
          recordingStatusCallbackMethod="POST"/>
  <Say>Thank you. Goodbye.</Say>
</Response>`);
    }

    if (!ownerId) {
      return res.status(200).send('<Response><Say>This number is not configured. Goodbye.</Say><Hangup/></Response>');
    }

    // Ring the owner's browser dialer; fall through to voicemail via action URL.
    // With the AI receptionist on, ring shorter so callers aren't left hanging.
    const fallbackParams = new URLSearchParams({ fallback: '1', user_id: ownerId, to: From || '', from: To || '' });
    const actionUrl = xmlEscape(`${baseUrl}/api/twilio-voice?${fallbackParams.toString()}`);
    const ringSecs = ownerAgent ? 13 : 20;

    return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="${ringSecs}" record="record-from-answer-dual"
        recordingStatusCallback="${recordingCallback}"
        recordingStatusCallbackMethod="POST"
        action="${actionUrl}" method="POST">
    <Client>${xmlEscape(ownerId)}</Client>
  </Dial>
</Response>`);
  }

  /* ── OUTBOUND: browser dialer call (From = "client:<user.id>") ─────────── */
  if (!To) {
    return res.status(400).send('<Response><Say>No destination number.</Say></Response>');
  }

  const userId = (From || '').replace(/^client:/, '');
  let callerId = process.env.TWILIO_PHONE_NUMBER || null;
  let disclose = false;

  if (userId && userId.length === 36 && supabase) {
    try {
      const { data: profile } = await supabase
        .from('profiles')
        .select('twilio_phone_number, record_disclosure')
        .eq('id', userId)
        .single();
      if (profile?.twilio_phone_number) callerId = profile.twilio_phone_number;
      disclose = profile?.record_disclosure === true;
    } catch (e) {
      console.error('Profile lookup error:', e);
    }
  }

  // Recording status callbacks don't include From/To/CallDuration — pass them via query params
  const cbParams = new URLSearchParams({
    user_id: userId || '',
    to: To || '',
    from: callerId || ''
  });
  const recordingCallbackXml = xmlEscape(`${baseUrl}/api/twilio-recording?${cbParams.toString()}`);

  // Omit callerId attribute if we don't have one so Twilio uses account default;
  // strip everything but digits/+ from To (it's user input going into XML)
  const callerIdAttr = callerId ? ` callerId="${xmlEscape(callerId)}"` : '';
  const safeTo = To.replace(/[^\d+]/g, '');
  const whisperAttr = disclose ? ` url="${xmlEscape(`${baseUrl}/api/twilio-voice?disclosure=1`)}" method="POST"` : '';

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial record="record-from-answer-dual"
        recordingStatusCallback="${recordingCallbackXml}"
        recordingStatusCallbackMethod="POST"${callerIdAttr}>
    <Number${whisperAttr}>${safeTo}</Number>
  </Dial>
</Response>`;

  res.status(200).send(twiml);
}


/* ════════════════ AI receptionist (missed-call lead intake) ════════════════ */

const AGENT_VOICE = 'Polly.Joanna-Neural';

function agentActionUrl(baseUrl, hop, userId, caller, owner) {
  const qs = new URLSearchParams({ agent: hop, user_id: userId || '', caller: caller || '', owner: owner || '' });
  return `${baseUrl}/api/twilio-voice?${qs.toString()}`;
}

function agentSay(text) {
  return `<Say voice="${AGENT_VOICE}">${xmlEscape(text)}</Say>`;
}

// speechTimeout=1 ends capture after 1s of silence (vs sluggish 'auto');
// experimental_conversations is Twilio's STT tuned for fast conversational turns
function agentGatherTwiML(baseUrl, userId, caller, owner, text) {
  const action = xmlEscape(agentActionUrl(baseUrl, '1', userId, caller, owner));
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${action}" method="POST" speechTimeout="1" speechModel="experimental_conversations" language="en-US">
    ${agentSay(text)}
  </Gather>
  ${agentSay("Sorry, I didn't catch anything. I'll let him know you called — he'll ring you back at this number. Thanks!")}
  <Hangup/>
</Response>`;
}

const AGENT_FILLERS = ['Okay.', 'Got it.', 'Mm-hmm.', 'One sec.'];

async function handleAgentTurn(req, res) {
  const baseUrl = process.env.TWILIO_WEBHOOK_BASE_URL
    ? process.env.TWILIO_WEBHOOK_BASE_URL.replace(/\/$/, '')
    : `https://${req.headers.host}`;
  const hop = String(req.query.agent || '1');
  const userId = req.query.user_id || '';
  const caller = req.query.caller || req.body.From || '';
  const owner = req.query.owner || '';
  const callSid = req.body.CallSid || '';

  const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    : null;
  const bail = (msg) => res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>\n<Response>${agentSay(msg)}<Hangup/></Response>`);
  if (!supabase || !callSid || !userId) return bail("I'll let him know you called. He'll call you back at this number. Thanks!");

  try {
    /* ── hop 1: speech just arrived — store it, speak a beat, think on the redirect ── */
    if (hop === '1') {
      const speech = String(req.body.SpeechResult || '').trim();
      let { data: sess } = await supabase.from('agent_sessions').select('history').eq('call_sid', callSid).maybeSingle();
      const history = Array.isArray(sess?.history) ? sess.history : [];
      history.push({ role: 'user', content: speech || '(silence)' });
      await supabase.from('agent_sessions').upsert({ call_sid: callSid, user_id: userId, caller, history });
      const filler = AGENT_FILLERS[history.filter(m => m.role === 'user').length % AGENT_FILLERS.length];
      const next = xmlEscape(agentActionUrl(baseUrl, '2', userId, caller, owner));
      // Filler audio plays WHILE Twilio fetches hop 2 — the think-time hides behind it
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>${agentSay(filler)}<Redirect method="POST">${next}</Redirect></Response>`);
    }

    /* ── hop 2: run the model turn, ask the next question (or say goodbye) ── */
    if (hop === '2') {
      const { data: sess } = await supabase.from('agent_sessions').select('history').eq('call_sid', callSid).maybeSingle();
      const history = Array.isArray(sess?.history) ? sess.history : [];
      if (!history.length) return bail("I'll let him know you called. Thanks!");

      const userTurns = history.filter(m => m.role === 'user').length;
      const mustWrap = userTurns >= 6;

      const system = `You are the friendly phone assistant for ${owner || 'a mortgage loan officer'}. He missed this call; your ONLY job is to collect callback info in a short, natural conversation, one question at a time.

Collect, in roughly this order (skip anything already given):
1. Their name
2. Whether they're a real estate agent, a current client, or a borrower — and in one sentence, what they need
3. The best number and time to call back (offer "this number works" — their caller ID is ${caller || 'unknown'})

Rules:
- ONE short question per turn. Conversational, warm, brief — this is a phone call.
- NEVER quote rates, give loan advice, or promise anything. If asked: "${(owner || 'He').split(' ')[0]} will cover that on the callback."
- If the caller wants to leave it at "just have him call me," that's fine — wrap up.
- ${mustWrap ? 'You are out of turns: thank them and wrap up NOW with done=true.' : 'Wrap up once you have a name plus a reason or callback preference.'}

Respond with ONLY valid JSON:
{"say":"what you say next (or the goodbye if done)","done":true|false,"lead":{"name":string|null,"caller_type":"agent"|"borrower"|"client"|"other"|null,"reason":string|null,"callback_number":string|null,"callback_time":string|null}}
"lead" reflects everything learned so far. The goodbye should confirm the callback plan in one sentence.`;

      let turn = null;
      try {
        const ar = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 160,
            system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
            messages: history
          })
        });
        const ad = await ar.json();
        const txt = (ad.content || []).map(b => b.text || '').join('').trim();
        turn = JSON.parse(txt.replace(/```json|```/g, '').trim());
      } catch (e) {
        console.error('agent turn AI error:', e);
      }
      if (!turn || typeof turn.say !== 'string') {
        turn = { say: "Got it. I'll have him call you back at this number as soon as he's free. Thanks for calling!", done: true, lead: {} };
      }

      history.push({ role: 'assistant', content: JSON.stringify(turn) });
      await supabase.from('agent_sessions').update({ history }).eq('call_sid', callSid);

      if (!turn.done && !mustWrap) {
        return res.status(200).send(agentGatherTwiML(baseUrl, userId, caller, owner, turn.say));
      }
      // Done: speak the goodbye NOW; the lead writes happen on the hop-3 redirect
      const fin = xmlEscape(agentActionUrl(baseUrl, '3', userId, caller, owner));
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>${agentSay(turn.say)}<Redirect method="POST">${fin}</Redirect></Response>`);
    }

    /* ── hop 3: caller already heard goodbye — persist the lead, hang up ── */
    const { data: sess } = await supabase.from('agent_sessions').select('history').eq('call_sid', callSid).maybeSingle();
    const history = Array.isArray(sess?.history) ? sess.history : [];
    let lead = {};
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'assistant') {
        try { lead = JSON.parse(history[i].content).lead || {}; } catch {}
        break;
      }
    }

    const digits = String(caller || '').replace(/\D/g, '');
    const ten = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
    const variants = [caller, '+1' + ten, ten, '1' + ten].filter(Boolean);
    let contactId = null;
    try {
      const { data: existing } = await supabase.from('contacts').select('id, name')
        .eq('user_id', userId).in('phone', variants).limit(1);
      const leadName = (lead.name || '').trim();
      if (existing?.length) {
        contactId = existing[0].id;
        if (leadName && (!existing[0].name || existing[0].name === 'Unknown')) {
          const parts = leadName.split(/\s+/);
          await supabase.from('contacts').update({ name: leadName, first_name: parts[0] || '', last_name: parts.slice(1).join(' ') || '' }).eq('id', contactId);
        }
      } else {
        const parts = (leadName || 'Unknown').split(/\s+/);
        const { data: created } = await supabase.from('contacts').insert({
          user_id: userId, phone: caller || ten, name: leadName || 'Unknown',
          first_name: parts[0] === 'Unknown' ? '' : parts[0],
          last_name: parts.slice(1).join(' ') || '',
          stage: lead.caller_type === 'agent' ? 'contacted' : 'new',
          notes: lead.reason || 'Inbound call — AI receptionist intake',
          heat_score: null, call_count: 1
        }).select('id').single();
        contactId = created?.id || null;
      }

      const convo = history.map(m => {
        if (m.role === 'user') return 'Caller: ' + m.content;
        try { return 'Assistant: ' + (JSON.parse(m.content).say || ''); } catch { return 'Assistant: ' + m.content; }
      }).join('\n');
      const summary = ['AI receptionist took this call.',
        lead.name ? 'Name: ' + lead.name : null,
        lead.caller_type ? 'Type: ' + lead.caller_type : null,
        lead.reason ? 'Needs: ' + lead.reason : null,
        'Call back: ' + (lead.callback_number || caller || 'caller ID') + (lead.callback_time ? ' — ' + lead.callback_time : '')
      ].filter(Boolean).join(' · ');

      const { data: callRow } = await supabase.from('calls').insert({
        call_sid: callSid, from_number: caller || '', to_number: '',
        duration: 0, transcript: 'AI RECEPTIONIST INTAKE\n' + convo,
        notes: summary, heat_score: lead.caller_type === 'borrower' ? 'Warm' : null,
        sentiment: null, next_step: 'Call back ' + (lead.callback_time || 'ASAP'),
        contact_id: contactId, user_id: userId
      }).select('id').single();

      await supabase.from('follow_ups').insert({
        user_id: userId, contact_id: contactId, call_id: callRow?.id || null,
        type: 'call',
        title: ('Call back ' + (lead.name || 'missed caller')).slice(0, 140),
        message: summary.slice(0, 300),
        scheduled_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        status: 'suggested'
      });
      await supabase.from('agent_sessions').delete().eq('call_sid', callSid);
    } catch (e) {
      console.error('agent finalize error:', e);
    }
    return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?>\n<Response><Hangup/></Response>');
  } catch (err) {
    console.error('handleAgentTurn error:', err);
    return bail("I'll make sure he knows you called. Thanks!");
  }
}
