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

  // Monthly counter reset (absorbed from the old /api/reset-calls cron —
  // Vercel Hobby allows limited functions and cron jobs, so this runs daily
  // and resets free-plan counters on the 1st)
  let monthlyReset = null;
  if (new Date().getUTCDate() === 1) {
    const { error: resetErr } = await supabase
      .from('profiles')
      .update({ calls_this_month: 0, billing_cycle_start: new Date().toISOString() })
      .eq('plan', 'free');
    monthlyReset = resetErr ? 'failed: ' + resetErr.message : 'done';
  }

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

        const sms = await client.messages.create({ body, from: fromPhone, to: toPhone });

        await supabase.from('follow_ups')
          .update({ status: 'sent', sent_at: new Date().toISOString() })
          .eq('id', fu.id);

        // Log into the SMS inbox thread
        await supabase.from('messages').insert({
          user_id: fu.user_id, contact_id: fu.contact_id, phone: toPhone,
          direction: 'outbound', body, twilio_sid: sms.sid, read: true
        });

        results.sent++;
      } catch (sendErr) {
        console.error(`Failed to send follow-up ${fu.id}:`, sendErr);
        results.failed++;
        results.errors.push({ id: fu.id, error: String(sendErr) });
      }
    }

    // ── Overage billing: invoice last month's metered minutes beyond the bundle.
    // Runs on the daily cron; idempotent via usage_minutes.reported. Inert until
    // STRIPE_SECRET_KEY is configured.
    let overageBilled = 0;
    if (process.env.STRIPE_SECRET_KEY) {
      try {
        const lastMonth = new Date();
        lastMonth.setUTCDate(1); lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
        const periodStart = lastMonth.toISOString().slice(0, 8) + '01';
        const BUNDLES = { solo: 1500, pro: 4000 };
        const { data: rows } = await supabase.from('usage_minutes')
          .select('user_id, minutes_used').eq('period_start', periodStart).eq('reported', false);
        // Team plans pool: aggregate each team's members and bill the owner once.
        const teamAgg = {}; // rootId -> { mins, memberRows }
        for (const row of rows || []) {
          const { data: prof } = await supabase.from('profiles')
            .select('plan, stripe_customer_id, team_owner_id').eq('id', row.user_id).single();
          const rootId = prof?.team_owner_id || row.user_id;
          let rootPlan = prof?.plan, rootCustomer = prof?.stripe_customer_id;
          if (rootId !== row.user_id) {
            const { data: root } = await supabase.from('profiles').select('plan, stripe_customer_id').eq('id', rootId).single();
            rootPlan = root?.plan; rootCustomer = root?.stripe_customer_id;
          }
          if (rootPlan === 'team') {
            teamAgg[rootId] = teamAgg[rootId] || { mins: 0, customer: rootCustomer, rows: [] };
            teamAgg[rootId].mins += Number(row.minutes_used);
            teamAgg[rootId].rows.push(row.user_id);
            continue;
          }
          const bundle = BUNDLES[prof?.plan];
          const over = bundle ? Math.max(0, Number(row.minutes_used) - bundle) : 0;
          if (over > 0 && prof?.stripe_customer_id) {
            const cents = Math.round(over * 3); // $0.03/min
            const body = new URLSearchParams({
              customer: prof.stripe_customer_id, amount: String(cents), currency: 'usd',
              description: `Dialer overage: ${Math.round(over)} min beyond the ${bundle.toLocaleString()}-min bundle (${periodStart.slice(0,7)})`
            });
            const r = await fetch('https://api.stripe.com/v1/invoiceitems', {
              method: 'POST',
              headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
              body
            });
            if (!r.ok) { console.error('Overage invoice failed for', row.user_id, await r.text()); continue; }
            overageBilled++;
          }
          await supabase.from('usage_minutes').update({ reported: true })
            .eq('user_id', row.user_id).eq('period_start', periodStart);
        }
        // Bill pooled team overage to each team owner
        for (const [rootId, agg] of Object.entries(teamAgg)) {
          const { count } = await supabase.from('profiles')
            .select('id', { count: 'exact', head: true })
            .or(`id.eq.${rootId},team_owner_id.eq.${rootId}`);
          const bundle = 4000 * (count || 1);
          const over = Math.max(0, agg.mins - bundle);
          if (over > 0 && agg.customer) {
            const body = new URLSearchParams({
              customer: agg.customer, amount: String(Math.round(over * 3)), currency: 'usd',
              description: `Team dialer overage: ${Math.round(over)} min beyond the pooled ${bundle.toLocaleString()}-min bundle (${periodStart.slice(0, 7)})`
            });
            const r = await fetch('https://api.stripe.com/v1/invoiceitems', {
              method: 'POST',
              headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
              body
            });
            if (!r.ok) { console.error('Team overage invoice failed for', rootId, await r.text()); continue; }
            overageBilled++;
          }
          for (const uid of agg.rows) {
            await supabase.from('usage_minutes').update({ reported: true })
              .eq('user_id', uid).eq('period_start', periodStart);
          }
        }
      } catch (e) { console.error('Overage billing error:', e); }
    }

    return res.status(200).json({ ok: true, processed: dueFollowUps?.length || 0, monthlyReset, overageBilled, ...results });
  } catch (err) {
    console.error('Process follow-ups error:', err);
    return res.status(500).json({ error: 'Processing error' });
  }
}
