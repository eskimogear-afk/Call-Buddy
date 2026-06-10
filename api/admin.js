import { createClient } from '@supabase/supabase-js';

// Team admin API — requires an authenticated user whose profiles.role = 'admin'
//  GET ?view=overview            → per-rep stats for the whole team
//  GET ?view=user_calls&user_id= → recent calls (with AI analysis) for one rep
//  POST { action:'set_role', user_id, role }  → promote/demote a rep (admin only)

const ALLOWED_ORIGIN = 'https://call-buddy-omega.vercel.app';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

  // Admin gate
  const { data: me } = await supabase.from('profiles').select('role, team_owner_id').eq('id', user.id).single();
  if (me?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  // Scope everything to the admin's team — only reps explicitly added to it appear
  const teamId = me.team_owner_id || user.id;

  try {
    if (req.method === 'GET' && (req.query.view === 'overview' || !req.query.view)) {
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      // Only profiles on this admin's team
      const { data: teamProfiles } = await supabase
        .from('profiles')
        .select('id, full_name, plan, role, twilio_phone_number, calls_this_month, created_at')
        .eq('team_owner_id', teamId);
      const teamIds = (teamProfiles || []).map(p => p.id);
      if (!teamIds.length) return res.status(200).json({ team: { reps: 0, calls_today: 0, calls_week: 0, hot: 0, warm: 0, pending_followups: 0 }, reps: [] });

      const [usersQ, callsQ, contactsQ, fusQ] = await Promise.all([
        supabase.auth.admin.listUsers({ perPage: 200 }),
        supabase.from('calls').select('user_id, created_at, heat_score, duration').in('user_id', teamIds).order('created_at', { ascending: false }).limit(3000),
        supabase.from('contacts').select('user_id, stage').in('user_id', teamIds).limit(5000),
        supabase.from('follow_ups').select('user_id, status').in('user_id', teamIds).eq('status', 'pending').limit(2000)
      ]);

      const emails = {};
      (usersQ?.data?.users || []).forEach(u => { emails[u.id] = u.email; });

      const calls = callsQ.data || [];
      const contacts = contactsQ.data || [];
      const fus = fusQ.data || [];

      const reps = (teamProfiles || []).map(p => {
        const mine = calls.filter(c => c.user_id === p.id);
        const week = mine.filter(c => c.created_at >= weekAgo);
        const today = mine.filter(c => c.created_at >= dayAgo);
        const talkSec = week.reduce((s, c) => s + (c.duration || 0), 0);
        return {
          id: p.id,
          name: p.full_name || emails[p.id] || 'Unknown',
          email: emails[p.id] || '',
          role: p.role || 'member',
          plan: p.plan || 'free',
          phone: p.twilio_phone_number || '',
          calls_total: mine.length,
          calls_week: week.length,
          calls_today: today.length,
          talk_seconds_week: talkSec,
          hot: mine.filter(c => c.heat_score === 'Hot').length,
          warm: mine.filter(c => c.heat_score === 'Warm').length,
          contacts: contacts.filter(x => x.user_id === p.id).length,
          pending_followups: fus.filter(x => x.user_id === p.id).length,
          last_call_at: mine[0]?.created_at || null,
          joined: p.created_at
        };
      }).sort((a, b) => b.calls_week - a.calls_week);

      return res.status(200).json({
        team: {
          reps: reps.length,
          calls_today: reps.reduce((s, r) => s + r.calls_today, 0),
          calls_week: reps.reduce((s, r) => s + r.calls_week, 0),
          hot: reps.reduce((s, r) => s + r.hot, 0),
          warm: reps.reduce((s, r) => s + r.warm, 0),
          pending_followups: reps.reduce((s, r) => s + r.pending_followups, 0)
        },
        reps
      });
    }

    if (req.method === 'GET' && req.query.view === 'user_calls') {
      const { user_id } = req.query;
      if (!user_id) return res.status(400).json({ error: 'user_id required' });
      // Only allow drilling into a rep on the admin's own team
      const { data: target } = await supabase.from('profiles').select('id').eq('id', user_id).eq('team_owner_id', teamId).single();
      if (!target) return res.status(403).json({ error: 'User is not on your team' });
      const { data, error } = await supabase
        .from('calls')
        .select('id, created_at, to_number, from_number, duration, heat_score, sentiment, notes, next_step, transcript, recording_url')
        .eq('user_id', user_id)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      // Trim transcripts so the payload stays light; expose only a has_recording flag, not the raw URL
      return res.status(200).json((data || []).map(c => ({
        id: c.id, created_at: c.created_at, to_number: c.to_number, from_number: c.from_number,
        duration: c.duration, heat_score: c.heat_score, sentiment: c.sentiment, next_step: c.next_step,
        notes: c.notes,
        transcript: String(c.transcript || '').startsWith('PENDING:') ? '' : String(c.transcript || '').slice(0, 600),
        has_recording: !!c.recording_url
      })));
    }

    // Stream a team member's call recording (admin only, team-scoped)
    if (req.method === 'GET' && req.query.view === 'recording') {
      const { call_id } = req.query;
      if (!call_id) return res.status(400).json({ error: 'call_id required' });
      const { data: call } = await supabase
        .from('calls').select('recording_url, user_id').eq('id', call_id).single();
      if (!call?.recording_url) return res.status(404).json({ error: 'No recording' });
      // Confirm the call's owner is on this admin's team
      const { data: owner } = await supabase.from('profiles').select('id').eq('id', call.user_id).eq('team_owner_id', teamId).single();
      if (!owner) return res.status(403).json({ error: 'Recording is not on your team' });
      if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN)
        return res.status(500).json({ error: 'Twilio not configured' });
      const a = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
      const tw = await fetch(call.recording_url, { headers: { Authorization: `Basic ${a}` } });
      if (!tw.ok) return res.status(502).json({ error: 'Recording fetch failed (' + tw.status + ')' });
      const buf = Buffer.from(await tw.arrayBuffer());
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      return res.status(200).send(buf);
    }

    if (req.method === 'POST' && req.body?.action === 'set_role') {
      const { user_id, role } = req.body;
      if (!user_id || !['admin', 'member'].includes(role)) return res.status(400).json({ error: 'user_id and role (admin|member) required' });
      if (user_id === user.id && role !== 'admin') return res.status(400).json({ error: 'You cannot demote yourself' });
      // Only change roles for reps on the admin's own team
      const { error } = await supabase.from('profiles').update({ role }).eq('id', user_id).eq('team_owner_id', teamId);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Admin API error:', err);
    return res.status(500).json({ error: String(err) });
  }
}
