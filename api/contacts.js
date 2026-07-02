import { createClient } from '@supabase/supabase-js';

// Scrub a batch of numbers against federal DNC + state DNC + litigators via
// the configured provider. Returns [{ phone, reasons:[...] }] for bad numbers.
// Default: TCPA Litigator List bulk endpoint (https://api.tcpalitigatorlist.com).
async function scrubPhones(phones) {
  const user = process.env.SCRUB_API_USER, pass = process.env.SCRUB_API_PASS;
  const auth = Buffer.from(`${user}:${pass}`).toString('base64');
  const tens = phones.map(p => {
    const d = String(p || '').replace(/\D/g, '');
    return d.length === 11 && d[0] === '1' ? d.slice(1) : d;
  }).filter(d => d.length === 10);
  if (!tens.length) return [];

  const r = await fetch('https://api.tcpalitigatorlist.com/scrub/phones/', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ phones: tens, type: 'all', small_list: true })
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const data = await r.json();

  // Normalize: the bulk endpoint returns per-number results; collect flagged ones.
  const out = [];
  const rows = Array.isArray(data?.results) ? data.results
    : (data?.results && typeof data.results === 'object') ? Object.values(data.results)
    : Array.isArray(data) ? data : [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const bad = row.is_bad_number === true || row.clean === 0 || row.clean === '0';
    if (bad) {
      const reasons = Array.isArray(row.status_array) ? row.status_array
        : (row.status ? [row.status] : ['flagged']);
      out.push({ phone: String(row.phone_number || ''), reasons });
    }
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://call-buddy-omega.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── PUBLIC: live mortgage-rate drivers from FRED (no auth — shown on the
  //    marketing site). Cached at the edge so we don't hammer FRED. ──
  if (req.query.resource === 'rates') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (!process.env.FRED_API_KEY) return res.status(503).json({ error: 'Rates not configured' });
    const SERIES = [
      { key: 'treasury10', id: 'DGS10', units: '', label: '10-Year Treasury', unit: '%', note: 'Mortgage rates track this most closely' },
      { key: 'mortgage30', id: 'MORTGAGE30US', units: '', label: '30-Yr Fixed Avg', unit: '%', note: 'Freddie Mac national average (weekly)' },
      { key: 'fedfunds', id: 'DFEDTARU', units: '', label: 'Fed Funds Rate', unit: '%', note: 'The Fed funds target — set at FOMC meetings' },
      { key: 'cpi', id: 'CPIAUCSL', units: 'pc1', label: 'Inflation (CPI)', unit: '% YoY', note: 'Hotter inflation pushes rates up' },
      { key: 'unemployment', id: 'UNRATE', units: '', label: 'Unemployment', unit: '%', note: 'A weaker job market tends to ease rates' },
      { key: 'jobs', id: 'PAYEMS', units: 'chg', label: 'Jobs Added', unit: 'K', note: 'Strong hiring tends to push rates up' }
    ];
    const fetchSeries = async (s) => {
      const base = { key: s.key, label: s.label, unit: s.unit, note: s.note, value: null, date: null, change: null };
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 6000);
        const u = s.units ? `&units=${s.units}` : '';
        const r = await fetch(`https://api.stlouisfed.org/fred/series/observations?series_id=${s.id}&api_key=${process.env.FRED_API_KEY}&file_type=json&sort_order=desc&limit=2${u}`, { signal: ctrl.signal });
        clearTimeout(timer);
        const d = await r.json();
        const obs = (d.observations || []).filter(o => o.value !== '.');
        const cur = obs[0], prev = obs[1];
        const rawVal = cur ? parseFloat(cur.value) : null;
        const pval = prev ? parseFloat(prev.value) : null;
        // FRED YoY (pc1) series return long decimals (e.g. 4.16661) — round to 2dp for clean display
        const val = rawVal != null ? Math.round(rawVal * 100) / 100 : null;
        return { ...base, value: val, date: cur?.date || null, change: (rawVal != null && pval != null) ? Math.round((rawVal - pval) * 100) / 100 : null };
      } catch (e) {
        console.error('rate series', s.id, 'failed:', e.message);
        return base;
      }
    };
    const out = await Promise.all(SERIES.map(fetchSeries));
    res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=3600');
    return res.status(200).json({ indicators: out, fetched_at: new Date().toISOString() });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY)
    return res.status(500).json({ error: 'Supabase not configured' });

  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  let user;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return res.status(401).json({ error: 'Unauthorized' });
    user = data.user;
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Canonicalize a phone to a match key: digits only, US 11-digit -> 10-digit
  const dncKey = (p) => {
    let d = String(p || '').replace(/\D/g, '');
    if (d.length === 11 && d[0] === '1') d = d.slice(1);
    return d;
  };

  try {
    // ── Call recording playback proxy (resource=recording&id=<callId>).
    //    Streams the user's own recording from Twilio with server-side auth so
    //    the credentials are never exposed to the browser. Folded in here to
    //    stay within Vercel's 12-function limit. ──
    if (req.query.resource === 'recording' && req.method === 'GET') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id required' });
      const { data: call } = await supabase
        .from('calls').select('recording_url').eq('id', id).eq('user_id', user.id).single();
      if (!call?.recording_url) return res.status(404).json({ error: 'No recording for this call' });
      if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN)
        return res.status(500).json({ error: 'Twilio not configured' });
      const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
      const tw = await fetch(call.recording_url, { headers: { Authorization: `Basic ${auth}` } });
      if (!tw.ok) return res.status(502).json({ error: 'Recording fetch failed (' + tw.status + ')' });
      const buf = Buffer.from(await tw.arrayBuffer());
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      return res.status(200).send(buf);
    }

    // ── Caller-ID lookup (resource=lookup&phone=<number>). Returns the Twilio
    //    caller-name (CNAM) + line type for any number, and cross-checks it
    //    against the user's own contacts and saved lead lists so they can see
    //    "who is this" before dialing or on a callback. Folded in here to stay
    //    within Vercel's 12-function limit. ──
    if (req.query.resource === 'lookup' && req.method === 'GET') {
      const key = dncKey(req.query.phone);          // 10-digit US match key
      if (key.length < 10) return res.status(400).json({ error: 'Enter a full 10-digit number' });
      const e164 = '+1' + key;
      const nat = '(' + key.slice(0, 3) + ') ' + key.slice(3, 6) + '-' + key.slice(6);

      // 1) Twilio caller-ID (CNAM) + line-type intelligence
      let cnam = null, caller_type = null, line_type = null, carrier = null, national_format = null;
      if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
        try {
          const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
          const lr = await fetch(`https://lookups.twilio.com/v2/PhoneNumbers/${e164}?Fields=caller_name,line_type_intelligence`, { headers: { Authorization: `Basic ${auth}` } });
          if (lr.ok) {
            const ld = await lr.json();
            national_format = ld.national_format || null;
            if (ld.caller_name) { cnam = ld.caller_name.caller_name || null; caller_type = ld.caller_name.caller_type || null; }
            if (ld.line_type_intelligence) { line_type = ld.line_type_intelligence.type || null; carrier = ld.line_type_intelligence.carrier_name || null; }
          }
        } catch (e) { console.error('lookup CNAM error:', e.message); }
      }

      // 2) Match against the user's own contacts (phone stored E.164 → ilike on the 10-digit key)
      let match = null;
      try {
        const { data: cs } = await supabase.from('contacts')
          .select('name,company,phone,city,city_suggested,city_status')
          .eq('user_id', user.id).ilike('phone', '%' + key + '%').limit(1);
        if (cs && cs.length) {
          const c = cs[0];
          match = { source: 'contact', name: c.name || '', company: c.company || '',
            city: (c.city_status === 'confirmed' && c.city) ? c.city : (c.city_suggested || c.city || '') };
        }
      } catch (e) { /* non-fatal */ }

      // 3) Match against saved lead lists (team_lists jsonb → scan leads by 10-digit key)
      if (!match) {
        try {
          const { data: prof } = await supabase.from('profiles').select('team_owner_id').eq('id', user.id).single();
          const root = (prof && prof.team_owner_id) || user.id;
          const { data: lists } = await supabase.from('team_lists').select('name,leads').eq('team_root', root);
          for (const tl of (lists || [])) {
            const hit = (Array.isArray(tl.leads) ? tl.leads : []).find(l => dncKey(l && l.phone) === key);
            if (hit) {
              match = { source: 'lead', list: tl.name || '', name: hit.name || '', company: hit.company || '',
                property: hit.property || '', mailing: hit.mailing || '', loan: hit.loan || '' };
              break;
            }
          }
        } catch (e) { /* non-fatal */ }
      }

      return res.status(200).json({ phone: e164, national_format: national_format || nat, cnam, caller_type, line_type, carrier, match });
    }

    // ── Real-time DNC / state / litigator scrub (resource=scrub).
    //    Proxies to a scrub provider so the API key stays server-side. Inert
    //    (configured:false) until SCRUB_API_USER/SCRUB_API_PASS env vars are
    //    set. Default provider: TCPA Litigator List bulk endpoint. ──
    if ((req.query.resource === 'scrub' || req.body?.resource === 'scrub')) {
      if (req.method === 'GET') {
        return res.status(200).json({ configured: !!(process.env.SCRUB_API_USER && process.env.SCRUB_API_PASS), provider: process.env.SCRUB_PROVIDER || 'tcpa_litigator_list' });
      }
      if (req.method === 'POST') {
        const phones = Array.isArray(req.body.phones) ? req.body.phones : [];
        if (!process.env.SCRUB_API_USER || !process.env.SCRUB_API_PASS) {
          return res.status(200).json({ configured: false, flagged: [] });
        }
        if (!phones.length) return res.status(200).json({ configured: true, flagged: [] });
        try {
          const flagged = await scrubPhones(phones.slice(0, 3000));
          return res.status(200).json({ configured: true, flagged });
        } catch (e) {
          console.error('Scrub error:', e);
          return res.status(502).json({ configured: true, error: 'Scrub provider error: ' + e.message, flagged: [] });
        }
      }
    }

    // ── Do Not Call list (folded into this endpoint to stay within Vercel's
    //    12-function limit). Triggered by resource=dnc on query or body. ──
    // ── Dialer minute metering (plan bundles, team pooling, overage) ────────
    // ── Short-lived Deepgram token for browser live-streaming (dialer co-pilot).
    //    Mints a 30-min, usage:write-only key from the Owner key so the real
    //    key never reaches the browser. ──
    if (req.query.resource === 'dg-token') {
      if (!process.env.DEEPGRAM_API_KEY || !process.env.DEEPGRAM_PROJECT_ID)
        return res.status(503).json({ error: 'Live transcription not configured' });
      try {
        const r = await fetch(`https://api.deepgram.com/v1/projects/${process.env.DEEPGRAM_PROJECT_ID}/keys`, {
          method: 'POST',
          headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ comment: `pitchlog-live-${String(user.id).slice(0, 8)}`, scopes: ['usage:write'], time_to_live_in_seconds: 1800 })
        });
        const d = await r.json();
        if (!d.key) { console.error('dg-token mint failed:', JSON.stringify(d).slice(0, 160)); return res.status(502).json({ error: 'Could not start live transcription' }); }
        return res.status(200).json({ token: d.key, expires_in: 1800 });
      } catch (e) {
        console.error('dg-token error:', e.message);
        return res.status(502).json({ error: 'Could not start live transcription' });
      }
    }

    if (req.query.resource === 'usage') {
      const period = new Date().toISOString().slice(0, 8) + '01';

      // Resolve the caller's billing scope: solo plans meter individually;
      // members of a 'team'-plan owner share one pooled bundle (4,000 × seats).
      async function usageScope() {
        const { data: me } = await supabase.from('profiles').select('plan, team_owner_id').eq('id', user.id).single();
        const rootId = me?.team_owner_id || user.id;
        let rootPlan = me?.plan;
        if (rootId !== user.id) {
          const { data: root } = await supabase.from('profiles').select('plan').eq('id', rootId).single();
          rootPlan = root?.plan;
        }
        if (rootPlan === 'team') {
          const { data: members } = await supabase.from('profiles').select('id')
            .or(`id.eq.${rootId},team_owner_id.eq.${rootId}`);
          const ids = [...new Set((members || []).map(m => m.id))];
          const { data: rows } = await supabase.from('usage_minutes').select('minutes_used')
            .in('user_id', ids).eq('period_start', period);
          const used = (rows || []).reduce((s, r) => s + Number(r.minutes_used || 0), 0);
          return { pooled: true, plan: 'team', included: 4000 * ids.length, used: Math.round(used * 10) / 10, seats: ids.length };
        }
        const BUNDLES = { free: 0, solo: 1500, pro: 4000, pro_legacy: null };
        const included = BUNDLES[me?.plan] !== undefined ? BUNDLES[me?.plan] : 0;
        const { data: row } = await supabase.from('usage_minutes').select('minutes_used')
          .eq('user_id', user.id).eq('period_start', period).maybeSingle();
        return { pooled: false, plan: me?.plan, included, used: Number(row?.minutes_used || 0) };
      }

      if (req.method === 'GET') {
        const sc = await usageScope();
        return res.status(200).json({ minutes_used: sc.used, included: sc.included, pooled: sc.pooled, seats: sc.seats || 1, period_start: period });
      }
      if (req.method === 'POST') {
        const add = Math.max(0, Math.min(120, Number(req.body?.minutes) || 0));
        const { data: row } = await supabase.from('usage_minutes').select('minutes_used')
          .eq('user_id', user.id).eq('period_start', period).maybeSingle();
        const mine = Math.round((Number(row?.minutes_used || 0) + add) * 10) / 10;
        await supabase.from('usage_minutes').upsert({ user_id: user.id, period_start: period, minutes_used: mine });
        const sc = await usageScope();
        const overage = sc.included !== null && sc.used > sc.included;
        return res.status(200).json({ minutes_used: sc.used, included: sc.included, pooled: sc.pooled, overage });
      }
    }

    if (req.query.resource === 'dnc' || req.body?.resource === 'dnc') {
      if (req.method === 'GET') {
        const { data, error } = await supabase
          .from('dnc_list').select('*').eq('user_id', user.id)
          .order('created_at', { ascending: false });
        if (error) throw error;
        return res.status(200).json(data);
      }
      if (req.method === 'POST') {
        const raw = Array.isArray(req.body.phones) ? req.body.phones : [req.body.phone];
        const reason = req.body.reason || '';
        const rows = [...new Set(raw.map(dncKey).filter(p => p.length >= 7))]
          .map(phone => ({ user_id: user.id, phone, reason }));
        if (!rows.length) return res.status(400).json({ error: 'No valid phone numbers' });
        const { data, error } = await supabase
          .from('dnc_list').upsert(rows, { onConflict: 'user_id,phone', ignoreDuplicates: true })
          .select();
        if (error) throw error;
        return res.status(201).json({ added: rows.length, rows: data });
      }
      if (req.method === 'DELETE') {
        const phone = dncKey(req.query.phone);
        if (!phone) return res.status(400).json({ error: 'phone required' });
        const { error } = await supabase.from('dnc_list').delete()
          .eq('user_id', user.id).eq('phone', phone);
        if (error) throw error;
        return res.status(200).json({ success: true });
      }
    }

    if (req.method === 'GET') {
      const { search, stage } = req.query;
      let query = supabase
        .from('contacts')
        .select('*, calls(id, created_at, heat_score, notes, duration, sentiment, next_step)')
        .eq('user_id', user.id)
        .order('last_called', { ascending: false });
      if (search) query = query.or(`name.ilike.%${search}%,company.ilike.%${search}%,phone.ilike.%${search}%`);
      if (stage) query = query.eq('stage', stage);
      const { data, error } = await query;
      if (error) throw error;
      return res.status(200).json(data);
    }

    if (req.method === 'POST') {
      const { name, phone, company, email, stage, notes,
              brokerage, agent_type, annual_transaction_volume, current_lender, last_closing_date } = req.body;
      const nameParts = String(name || '').trim().split(/\s+/).filter(Boolean);
      const { data, error } = await supabase
        .from('contacts')
        .insert({
          user_id: user.id,
          name: name || 'Unknown',
          first_name: nameParts[0] || '',
          last_name: nameParts.slice(1).join(' ') || '',
          phone, company: company || '', email: email || '',
          stage: stage || 'new', notes: notes || '',
          brokerage: brokerage || '', agent_type: agent_type || '',
          annual_transaction_volume: annual_transaction_volume || '',
          current_lender: current_lender || '',
          last_closing_date: last_closing_date || null,
          heat_score: null, call_count: 0
        })
        .select().single();
      if (error) throw error;
      return res.status(201).json(data);
    }

    if (req.method === 'PUT') {
      const { id, ...raw } = req.body;
      if (!id) return res.status(400).json({ error: 'Missing id' });
      // Whitelist updatable columns — never trust the client to set user_id,
      // call_count, timestamps, or any column not meant to be user-editable.
      const ALLOWED = ['name', 'first_name', 'last_name', 'phone', 'company', 'email',
        'stage', 'notes', 'heat_score', 'brokerage', 'agent_type',
        'annual_transaction_volume', 'current_lender', 'last_closing_date',
        'city', 'city_status', 'address'];
      const updates = {};
      for (const k of ALLOWED) if (k in raw) updates[k] = raw[k];
      if (!Object.keys(updates).length) return res.status(400).json({ error: 'No updatable fields' });
      const { data, error } = await supabase
        .from('contacts')
        .update(updates)
        .eq('id', id).eq('user_id', user.id)
        .select().single();
      if (error) throw error;
      return res.status(200).json(data);
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'Missing id' });
      const { error } = await supabase.from('contacts').delete()
        .eq('id', id).eq('user_id', user.id);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Contacts error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}
