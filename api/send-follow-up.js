import twilio from 'twilio';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://call-buddy-omega.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY)
    return res.status(500).json({ error: 'Supabase not configured' });
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN)
    return res.status(500).json({ error: 'Twilio not configured' });

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

  const { follow_up_id } = req.body || {};
  if (!follow_up_id) return res.status(400).json({ error: 'follow_up_id required' });

  try {
    const { data: followUp, error: fuError } = await supabase
      .from('follow_ups')
      .select('*, contacts(id, name, phone, follow_up_count)')
      .eq('id', follow_up_id)
      .eq('user_id', user.id)
      .single();

    if (fuError || !followUp) return res.status(404).json({ error: 'Follow-up not found' });
    if (followUp.status === 'sent') return res.status(400).json({ error: 'Already sent' });

    const toPhone = followUp.contacts?.phone;
    if (!toPhone) return res.status(400).json({ error: 'Contact has no phone number' });

    const { data: profile } = await supabase
      .from('profiles')
      .select('twilio_phone_number')
      .eq('id', user.id)
      .single();

    const fromPhone = profile?.twilio_phone_number || process.env.TWILIO_PHONE_NUMBER;
    if (!fromPhone) return res.status(500).json({ error: 'No outbound phone number configured for your account' });

    const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const smsBody = followUp.message ||
      `Hi ${followUp.contacts?.name || 'there'}, just following up. Let me know if you have any questions!`;

    const sms = await twilioClient.messages.create({
      body: smsBody,
      from: fromPhone,
      to: toPhone
    });

    // Mark follow-up as sent
    await supabase.from('follow_ups')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .eq('id', follow_up_id);

    // Increment follow_up_count on the contact
    const currentCount = followUp.contacts?.follow_up_count || 0;
    await supabase.from('contacts')
      .update({ follow_up_count: currentCount + 1 })
      .eq('id', followUp.contact_id)
      .eq('user_id', user.id);

    return res.status(200).json({ success: true, sid: sms.sid });
  } catch (err) {
    console.error('Send follow-up error:', err);
    return res.status(500).json({ error: String(err) });
  }
}
