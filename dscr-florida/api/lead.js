import { createClient } from '@supabase/supabase-js';
import twilio from 'twilio';
import crypto from 'node:crypto';

// POST /api/lead
// Public lead-capture endpoint for the DSCR landing page.
// Flow: validate -> insert into mortgage_leads -> fire instant Twilio text -> 201.
// A failed text must NEVER fail the lead save (the lead is the asset).

const ALLOWED_PURPOSES = ['purchase', 'refi_rate_term', 'refi_cash_out', 'brrrr'];

function setCors(res) {
  // Public form — allow any origin (it only accepts writes, never reads).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function clean(v, max = 300) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, max);
}

function toNumber(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY)
    return res.status(500).json({ error: 'Supabase not configured' });

  // Vercel parses JSON bodies automatically; guard against raw strings just in case.
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const name = clean(body.name, 120);
  const phone = clean(body.phone, 40);
  if (!name || !phone)
    return res.status(400).json({ error: 'Name and phone are required' });

  let loanPurpose = clean(body.loan_purpose, 40);
  if (loanPurpose && !ALLOWED_PURPOSES.includes(loanPurpose)) loanPurpose = null;

  const lead = {
    name,
    phone,
    email: clean(body.email, 160),
    property_address: clean(body.property_address, 300),
    city: clean(body.city, 120),
    loan_purpose: loanPurpose,
    property_type: clean(body.property_type, 60),
    estimated_value: toNumber(body.estimated_value),
    estimated_rent: toNumber(body.estimated_rent),
    dscr_ratio: toNumber(body.dscr_ratio),
    utm_source: clean(body.utm_source, 120),
    utm_medium: clean(body.utm_medium, 120),
    utm_campaign: clean(body.utm_campaign, 120),
    notes: clean(body.notes, 1000),
  };

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  let saved;
  try {
    const { data, error } = await supabase
      .from('mortgage_leads')
      .insert(lead)
      .select()
      .single();
    if (error) throw error;
    saved = data;
  } catch (err) {
    console.error('Lead insert failed:', err);
    return res.status(500).json({ error: 'Could not save lead' });
  }

  // Fire the instant "speed to lead" text. Never blocks/breaks the save.
  await sendNotificationText(lead).catch((err) =>
    console.error('Lead notification text failed:', err)
  );

  // Server-side Meta Conversions API "Lead" event (for Facebook/IG ads).
  // Deduplicated with the browser Pixel via event_id. Never blocks the save.
  await sendMetaCapi(lead, body, req).catch((err) =>
    console.error('Meta CAPI failed:', err)
  );

  return res.status(201).json({ ok: true, id: saved.id });
}

// ---- Meta Conversions API (Facebook/Instagram ads) ----
function sha256(v) {
  return crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');
}
function normPhone(p) {
  let d = String(p).replace(/\D/g, '');
  if (d.length === 10) d = '1' + d; // assume US
  return d;
}
async function sendMetaCapi(lead, body, req) {
  const pid = process.env.META_PIXEL_ID;
  const token = process.env.META_CONVERSIONS_TOKEN;
  if (!pid || !token) return; // not configured → skip silently

  const user_data = { client_user_agent: req.headers['user-agent'] || '' };
  if (lead.email) user_data.em = [sha256(lead.email)];
  if (lead.phone) user_data.ph = [sha256(normPhone(lead.phone))];
  if (lead.city) user_data.ct = [sha256(lead.city.replace(/\s+/g, ''))];
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (ip) user_data.client_ip_address = ip;
  if (body.fbp) user_data.fbp = body.fbp;
  if (body.fbc) user_data.fbc = body.fbc;

  const payload = {
    data: [{
      event_name: 'Lead',
      event_time: Math.floor(Date.now() / 1000),
      event_id: clean(body.event_id, 100) || undefined,
      action_source: 'website',
      event_source_url: clean(body.event_source_url, 500) || undefined,
      user_data,
      custom_data: {
        value: 1, currency: 'USD',
        content_name: lead.loan_purpose || 'DSCR inquiry',
      },
    }],
  };

  const url = `https://graph.facebook.com/v19.0/${pid}/events?access_token=${encodeURIComponent(token)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    console.error('Meta CAPI non-200:', r.status, t.slice(0, 300));
  }
}

async function sendNotificationText(lead) {
  const to = process.env.LEAD_NOTIFY_PHONE || '+17542566781';
  const from = process.env.TWILIO_PHONE_NUMBER;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;

  if (!sid || !token || !from) {
    console.warn('Twilio not configured — skipping lead notification text.');
    return;
  }

  const purposeLabel = {
    purchase: 'Purchase',
    refi_rate_term: 'Rate/term refi',
    refi_cash_out: 'Cash-out refi',
    brrrr: 'BRRRR',
  }[lead.loan_purpose] || 'DSCR inquiry';

  const parts = [
    `New DSCR lead: ${lead.name}`,
    lead.phone,
    lead.city ? lead.city : null,
    purposeLabel,
  ].filter(Boolean);

  let body = '\u{1F525} ' + parts.join(' — ');
  if (lead.estimated_rent) body += ` | Est rent $${lead.estimated_rent}`;
  if (lead.dscr_ratio) body += ` | DSCR ${lead.dscr_ratio}`;
  body += '. Call within 5 min.';

  const client = twilio(sid, token);
  await client.messages.create({ body, from, to });
}
