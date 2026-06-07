import twilio from 'twilio';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://call-buddy-omega.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Secret');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { userId, mode = 'auto', phoneNumber, areaCode } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

  try {
    let assignedNumber;

    if (mode === 'assign') {
      // Manually assign an existing number from your Twilio account
      if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber required for assign mode' });
      assignedNumber = phoneNumber;
    } else {
      // Auto-provision: search for an available number and purchase it
      const searchParams = { voiceEnabled: true, smsEnabled: true, limit: 1 };
      if (areaCode) searchParams.areaCode = areaCode;

      const available = await client.availablePhoneNumbers('US').local.list(searchParams);
      if (!available.length) {
        // Fall back to any area code if the requested one has nothing
        const fallback = await client.availablePhoneNumbers('US').local.list({ voiceEnabled: true, smsEnabled: true, limit: 1 });
        if (!fallback.length) return res.status(404).json({ error: 'No numbers available' });
        available.push(fallback[0]);
      }

      const purchased = await client.incomingPhoneNumbers.create({
        phoneNumber: available[0].phoneNumber,
        // Voice URL points to the TwiML App, not the endpoint directly
        voiceApplicationSid: process.env.TWILIO_TWIML_APP_SID,
      });
      assignedNumber = purchased.phoneNumber;
    }

    // Store in user's profile
    const { error } = await supabase
      .from('profiles')
      .update({
        twilio_phone_number: assignedNumber,
        onboarding_complete: true,
        updated_at: new Date().toISOString()
      })
      .eq('id', userId);

    if (error) throw error;

    res.status(200).json({ success: true, phoneNumber: assignedNumber, userId });
  } catch (err) {
    console.error('Provision error:', err);
    res.status(500).json({ error: err.message || String(err) });
  }
}
