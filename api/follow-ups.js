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

  try {
    if (req.method === 'GET') {
      const { status = 'pending', contact_id, limit = 50 } = req.query;
      let query = supabase
        .from('follow_ups')
        .select('*, contacts(id, name, phone, company)')
        .eq('user_id', user.id)
        .order('scheduled_at', { ascending: true })
        .limit(parseInt(limit));

      if (status !== 'all') query = query.eq('status', status);
      if (contact_id) query = query.eq('contact_id', contact_id);

      const { data, error } = await query;
      if (error) throw error;
      return res.status(200).json(data);
    }

    if (req.method === 'POST' && req.body?.action === 'send_now') {
      // Send a pending follow-up SMS immediately (was /api/send-follow-up,
      // merged here to stay within the 12-function Vercel Hobby limit)
      const { follow_up_id } = req.body || {};
      if (!follow_up_id) return res.status(400).json({ error: 'follow_up_id required' });
      if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN)
        return res.status(500).json({ error: 'Twilio not configured' });

      const { data: followUp, error: fuError } = await supabase
        .from('follow_ups')
        .select('*, contacts(id, name, phone, follow_up_count)')
        .eq('id', follow_up_id)
        .eq('user_id', user.id)
        .single();
      if (fuError || !followUp) return res.status(404).json({ error: 'Follow-up not found' });
      if (followUp.status === 'sent') return res.status(400).json({ error: 'Already sent' });
      if (followUp.status === 'suggested') return res.status(400).json({ error: 'Confirm this suggested follow-up before sending' });

      const toPhone = followUp.contacts?.phone;
      if (!toPhone) return res.status(400).json({ error: 'Contact has no phone number' });

      const { data: profile } = await supabase
        .from('profiles').select('twilio_phone_number').eq('id', user.id).single();
      const fromPhone = profile?.twilio_phone_number || process.env.TWILIO_PHONE_NUMBER;
      if (!fromPhone) return res.status(500).json({ error: 'No outbound phone number configured for your account' });

      const twilio = (await import('twilio')).default;
      const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      const smsBody = followUp.message ||
        `Hi ${followUp.contacts?.name || 'there'}, just following up. Let me know if you have any questions!`;
      const sms = await client.messages.create({ body: smsBody, from: fromPhone, to: toPhone });

      await supabase.from('follow_ups')
        .update({ status: 'sent', sent_at: new Date().toISOString() })
        .eq('id', follow_up_id);
      await supabase.from('contacts')
        .update({ follow_up_count: (followUp.contacts?.follow_up_count || 0) + 1 })
        .eq('id', followUp.contact_id).eq('user_id', user.id);
      // Log into the SMS inbox thread
      await supabase.from('messages').insert({
        user_id: user.id, contact_id: followUp.contact_id, phone: toPhone,
        direction: 'outbound', body: smsBody, twilio_sid: sms.sid, read: true
      });

      return res.status(200).json({ success: true, sid: sms.sid });
    }

    if (req.method === 'POST') {
      const { contact_id, call_id, type, message, scheduled_at, title, location, duration_minutes } = req.body || {};
      if (!contact_id || !scheduled_at) return res.status(400).json({ error: 'contact_id and scheduled_at required' });

      const { data, error } = await supabase
        .from('follow_ups')
        .insert({
          user_id: user.id,
          contact_id,
          call_id: call_id || null,
          type: type || 'task',
          title: title || '',
          message: message || '',
          location: location || '',
          duration_minutes: duration_minutes || null,
          scheduled_at,
          status: 'pending'
        })
        .select('*, contacts(id, name, phone)')
        .single();
      if (error) throw error;

      // Update contact's next_follow_up_at if this is sooner
      await supabase.rpc('update_contact_next_followup', {
        p_contact_id: contact_id,
        p_user_id: user.id
      }).catch(() => {
        // RPC might not exist — update directly
        return supabase.from('contacts').update({ next_follow_up_at: scheduled_at })
          .eq('id', contact_id).eq('user_id', user.id);
      });

      return res.status(201).json(data);
    }

    if (req.method === 'PUT') {
      const { id, ...updates } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id required' });

      const allowed = ['message', 'scheduled_at', 'status', 'sent_at', 'type', 'title', 'location', 'duration_minutes'];
      const filtered = Object.fromEntries(Object.entries(updates).filter(([k]) => allowed.includes(k)));

      const { data, error } = await supabase
        .from('follow_ups')
        .update(filtered)
        .eq('id', id).eq('user_id', user.id)
        .select().single();
      if (error) throw error;
      return res.status(200).json(data);
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id required' });
      const { error } = await supabase.from('follow_ups').delete()
        .eq('id', id).eq('user_id', user.id);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Follow-ups error:', err);
    return res.status(500).json({ error: String(err) });
  }
}
