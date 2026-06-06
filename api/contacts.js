import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Unauthorized' });

  try {
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
          heat_score: 0, call_count: 0
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
      const { error } = await supabase
        .from('contacts').delete()
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
