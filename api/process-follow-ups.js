import twilio from 'twilio';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET')
    return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers['authorization'] || '';
  const bearerToken = authHeader.replace(/^Bearer\s+/i, '');
  const secret = bearerToken || req.headers['x-cron-secret'] || req.query.secret;
  if (!secret || secret !== process.env.CRON_SECRET)
    return res.status(401).json({ error: 'Unauthorized' });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY)
    return res.status(500).json({ error: 'Supabase not configured' });
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN)
    return res.status(500).json({ error: 'Twilio not configured' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

  try {
    // Fetch pending SMS follow-ups that are due
    const { data: dueFollowUps, error } = await supabase
      .from('follow_ups')
      .select('*, contacts(id, name, phone)')
      .eq('status', 'pending')
      .eq('type', 'sms')
      .lte('scheduled_at', new Date().toISOString())
      .limit(100);

    if (error) throw error;

    const results = { sent: 0, failed: 0, skipped: 0, errors: [] };

    for (const fu of dueFollowUps || []) {
      const toPhone = fu.contacts?.phone;

      // Look up the sender's phone number from their profile separately
      let fromPhone = process.env.TWILIO_PHONE_NUMBER || null;
      if (fu.user_id) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('twilio_phone_number')
          .eq('id', fu.user_id)
          .single();
        if (profile?.twilio_phone_number) fromPhone = profile.twilio_phone_number;
      }

      if (!toPhone || !fromPhone) {
        console.warn(`Follow-up ${fu.id} skipped — toPhone: ${toPhone}, fromPhone: ${fromPhone}`);
        results.skipped++;
        continue;
      }

      try {
        const body = fu.message ||
          `Hi ${fu.contacts?.name || 'there'}, just following up on our conversation. Feel free to reach out with any questions!`;

        await client.messages.create({ body, from: fromPhone, to: toPhone });

        await supabase.from('follow_ups')
          .update({ status: 'sent', sent_at: new Date().toISOString() })
          .eq('id', fu.id);

        results.sent++;
      } catch (sendErr) {
        console.error(`Failed to send follow-up ${fu.id}:`, sendErr);
        results.failed++;
        results.errors.push({ id: fu.id, error: String(sendErr) });
      }
    }

    return res.status(200).json({ ok: true, processed: dueFollowUps?.length || 0, ...results });
  } catch (err) {
    console.error('Process follow-ups error:', err);
    return res.status(500).json({ error: String(err) });
  }
}
