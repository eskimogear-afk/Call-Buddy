import { createClient } from '@supabase/supabase-js';

// Team admin API — two access modes:
//  1. Authenticated user whose profiles.role = 'admin' (full access)
//  2. Share-link token (?share=ADMIN_SHARE_TOKEN) — read-only, scoped to
//     ADMIN_SHARE_TEAM_ID's team; revoke by rotating/removing the env var
//  GET ?view=overview            → per-rep stats for the whole team
//  GET ?view=user_calls&user_id= → recent calls (with AI analysis) for one rep
//  GET ?view=recording&call_id=  → stream a rep's call recording
//  POST { action:'set_role', user_id, role }  → promote/demote (NOT in share mode)

const ALLOWED_ORIGIN = 'https://call-buddy-omega.vercel.app';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY)
    return res.status(500).json({ error: 'Supabase not configured' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  let teamId = null;
  let readOnly = false;

  const shareToken = req.query.share || '';
  if (shareToken && process.env.ADMIN_SHARE_TOKEN && shareToken === process.env.ADMIN_SHARE_TOKEN && process.env.ADMIN_SHARE_TEAM_ID) {
    // Share-link mode: read-only access to the configured team
    teamId = process.env.ADMIN_SHARE_TEAM_ID;
    readOnly = true;
  } else {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

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
    teamId = me.team_owner_id || user.id;
    var authedUserId = user.id;
  }

  if (req.method !== 'GET' && readOnly) return res.status(403).json({ error: 'Share link is read-only' });

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
      if (!teamIds.length) return res.status(200).json({ team: { pool_used: 0, pool_included: null, reps: 0, calls_today: 0, calls_week: 0, hot: 0, warm: 0, pending_followups: 0 }, reps: [] });

      const period = new Date().toISOString().slice(0, 8) + '01';
      const [usersQ, callsQ, contactsQ, fusQ, usageQ, ownerQ] = await Promise.all([
        supabase.auth.admin.listUsers({ perPage: 200 }),
        supabase.from('calls').select('user_id, created_at, heat_score, duration, from_number, to_number').in('user_id', teamIds).order('created_at', { ascending: false }).limit(3000),
        supabase.from('contacts').select('user_id, stage').in('user_id', teamIds).limit(5000),
        supabase.from('follow_ups').select('user_id, status').in('user_id', teamIds).eq('status', 'pending').limit(2000),
        supabase.from('usage_minutes').select('user_id, minutes_used').in('user_id', teamIds).eq('period_start', period),
        supabase.from('profiles').select('plan').eq('id', teamId).single()
      ]);
      const usage = usageQ.data || [];
      const poolUsed = Math.round(usage.reduce((s, r) => s + Number(r.minutes_used || 0), 0) * 10) / 10;
      const poolIncluded = ownerQ.data?.plan === 'team' ? 4000 * teamIds.length : null;

      const emails = {};
      (usersQ?.data?.users || []).forEach(u => { emails[u.id] = u.email; });

      // Exclude the secondary verified number's calls from all portal stats
      const EXCLUDED_LINE = '5174490792';
      const onExcluded = (n) => String(n || '').replace(/\D/g, '').endsWith(EXCLUDED_LINE);
      const calls = (callsQ.data || []).filter(c => !onExcluded(c.from_number) && !onExcluded(c.to_number));
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
          minutes_this_period: Math.round(Number((usage.find(u => u.user_id === p.id) || {}).minutes_used || 0)),
          last_call_at: mine[0]?.created_at || null,
          joined: p.created_at
        };
      }).sort((a, b) => b.calls_week - a.calls_week);

      return res.status(200).json({
        team: { pool_used: poolUsed, pool_included: poolIncluded,
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
      if (user_id === authedUserId && role !== 'admin') return res.status(400).json({ error: 'You cannot demote yourself' });
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
