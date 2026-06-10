import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://call-buddy-omega.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

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
    // ── Do Not Call list (folded into this endpoint to stay within Vercel's
    //    12-function limit). Triggered by resource=dnc on query or body. ──
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
      const { name, phone, company, email, stage, notes } = req.body;
      const { data, error } = await supabase
        .from('contacts')
        .insert({
          user_id: user.id,
          name: name || 'Unknown',
          phone, company: company || '', email: email || '',
          stage: stage || 'new', notes: notes || '',
          heat_score: null, call_count: 0
        })
        .select().single();
      if (error) throw error;
      return res.status(201).json(data);
    }

    if (req.method === 'PUT') {
      const { id, ...updates } = req.body;
      if (!id) return res.status(400).json({ error: 'Missing id' });
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
    res.status(500).json({ error: String(err) });
  }
}
