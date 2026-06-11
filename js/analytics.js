/* ═══════════════════════════════════════════════════════
   ANALYTICS PANEL
   Dial volume comes from the `dials` table (one row per
   attempt, answered flag) and falls back to logged calls
   for accounts predating dial tracking. Conversation
   quality, outcomes, and the funnel come from logged
   calls + contact stages.
═══════════════════════════════════════════════════════ */
const AN_CONNECTED = ['Interested', 'Not interested', 'Callback'];
const AN_OPEN_STAGES = ['new', 'contacted', 'meeting'];
const AN_MEETING_STAGES = ['meeting', 'comarketing', 'referral', 'partner'];
const AN_PARTNER_STAGES = ['comarketing', 'referral', 'partner'];
const AN_STALE_DAYS = 14;
const AN_DAY = 86400000;
let anCharts = {};

function dialGoal() {
  const v = parseInt(localStorage.getItem('pitchlog_dial_goal'), 10);
  return v > 0 ? v : 50;
}

function changeDialGoal() {
  const v = parseInt(prompt('Daily dial goal:', dialGoal()), 10);
  if (v > 0) { localStorage.setItem('pitchlog_dial_goal', v); renderAnalytics(); }
}

const anSecs = r => Number(r.duration_seconds || r.duration || 0);

/* A logged call counts as a real conversation: explicit connected
   outcome, or — for dialer rows with no outcome set — 30s+ on the line. */
function anIsConvo(r) {
  if (AN_CONNECTED.includes(r.outcome)) return true;
  if (r.outcome) return false;
  return anSecs(r) >= 30;
}

function anSet(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
const anPct = (n, d) => d ? Math.round(n / d * 100) + '%' : '—';
const anVar = name => getComputedStyle(document.body).getPropertyValue(name).trim();

async function renderAnalytics() {
  // Dial attempts, rolling 30 days (RLS-scoped to the user)
  let dials = [];
  try {
    const since = new Date(Date.now() - 30 * AN_DAY).toISOString();
    const { data } = await db.from('dials').select('created_at, answered').gte('created_at', since).limit(5000);
    dials = data || [];
  } catch (e) { dials = []; }

  const empty = document.getElementById('analytics-empty');
  const body = document.getElementById('analytics-body');
  if (!records.length && !dials.length) { empty.classList.remove('hidden'); body.classList.add('hidden'); return; }
  empty.classList.add('hidden'); body.classList.remove('hidden');

  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const d7 = new Date(now - 7 * AN_DAY);
  const d14 = new Date(now - 14 * AN_DAY);
  const d30 = new Date(now - 30 * AN_DAY);

  // Volume rows: {t: Date, ok: connected}
  const fromDials = dials.length > 0;
  const vol = fromDials
    ? dials.map(d => ({ t: new Date(d.created_at), ok: !!d.answered }))
    : records.map(r => ({ t: new Date(r.created_at), ok: anIsConvo(r) }));

  const today = vol.filter(v => v.t >= startToday);
  anSet('an-dials', today.length);
  const goal = dialGoal();
  const bar = document.getElementById('an-goal-bar');
  if (bar) bar.style.width = Math.min(100, Math.round(today.length / goal * 100)) + '%';
  anSet('an-goal-lbl', 'goal ' + goal + (today.length >= goal ? ' — hit!' : ''));

  const win7 = vol.filter(v => v.t >= d7);
  const prev7 = vol.filter(v => v.t >= d14 && v.t < d7);
  const ok7 = win7.filter(v => v.ok);
  anSet('an-connect', anPct(ok7.length, win7.length));
  const sub = document.getElementById('an-connect-sub');
  if (sub) {
    if (win7.length >= 10 && prev7.length >= 10) {
      const d = Math.round(ok7.length / win7.length * 100 - prev7.filter(v => v.ok).length / prev7.length * 100);
      sub.textContent = (d >= 0 ? '+' : '') + d + ' pts vs prior week';
    } else {
      sub.textContent = ok7.length + ' answered of ' + win7.length + ' dials';
    }
  }

  const calls7 = records.filter(r => new Date(r.created_at) >= d7);
  const convo7 = calls7.filter(anIsConvo);
  const int7 = calls7.filter(r => r.outcome === 'Interested');
  anSet('an-interested', anPct(int7.length, convo7.length));
  anSet('an-interested-sub', int7.length + ' of ' + convo7.length + ' conversations');

  anRenderDaily(vol, now, fromDials);
  anRenderHour(vol, fromDials);
  anRenderOutcomes(d30);
  anRenderFunnel(window.__anContacts || null);

  anLoadContacts();
  anLoadFollowUps();
  anLoadSms();
}

async function anLoadFollowUps() {
  try {
    const items = await inboxFetch('/api/follow-ups?status=pending&limit=500');
    if (!Array.isArray(items)) throw new Error('bad response');
    const now = new Date();
    const endToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const due = items.filter(f => new Date(f.scheduled_at) < endToday);
    const overdue = items.filter(f => new Date(f.scheduled_at) <= now);
    anSet('an-due', due.length);
    anSet('an-due-sub', overdue.length ? overdue.length + ' overdue' : 'nothing overdue');
  } catch (e) { anSet('an-due', '—'); anSet('an-due-sub', ''); }
}

function anHeatPill(label, count, fg, bg) {
  return `<span style="background:${bg};color:${fg};font-size:11px;font-weight:700;padding:2px 9px;border-radius:99px">${label} ${count}</span>`;
}

async function anLoadContacts() {
  try {
    const list = await inboxFetch('/api/contacts');
    if (!Array.isArray(list)) throw new Error('bad response');
    window.__anContacts = list;
    const now = new Date();
    const open = list.filter(c => AN_OPEN_STAGES.includes(c.stage || 'new'));
    const hotNoNext = open.filter(c => c.heat_score === 'Hot' && (!c.next_follow_up_at || new Date(c.next_follow_up_at) <= now));
    anSet('an-hotnonext', hotNoNext.length);
    const heat = { Hot: 0, Warm: 0, Cold: 0 };
    list.forEach(c => { heat[heat.hasOwnProperty(c.heat_score) ? c.heat_score : 'Cold']++; });
    const heatEl = document.getElementById('an-heat');
    if (heatEl) heatEl.innerHTML =
      anHeatPill('Hot', heat.Hot, 'var(--hot)', 'var(--hot-bg)') +
      anHeatPill('Warm', heat.Warm, 'var(--warm)', 'var(--warm-bg)') +
      anHeatPill('Cold', heat.Cold, 'var(--cold)', 'var(--cold-bg)');
    const stale = open.filter(c => { const ref = c.last_called || c.created_at; return ref && now - new Date(ref) > AN_STALE_DAYS * AN_DAY; });
    anSet('an-stale', stale.length);
    anRenderFunnel(list);
  } catch (e) {
    anSet('an-hotnonext', '—'); anSet('an-stale', '—');
    const heatEl = document.getElementById('an-heat');
    if (heatEl) heatEl.innerHTML = '<span style="font-size:11px;color:var(--text3)">couldn’t load contacts</span>';
  }
}

async function anLoadSms() {
  try {
    const msgs = await inboxFetch('/api/twilio-sms?limit=500');
    if (!Array.isArray(msgs)) throw new Error('bad response');
    const texted = new Set(), replied = new Set();
    msgs.forEach(m => { if (m.direction === 'outbound') texted.add(m.phone); });
    msgs.forEach(m => { if (m.direction === 'inbound' && texted.has(m.phone)) replied.add(m.phone); });
    if (!texted.size) { anSet('an-sms', '—'); anSet('an-sms-sub', 'no texts sent yet'); return; }
    anSet('an-sms', Math.round(replied.size / texted.size * 100) + '%');
    anSet('an-sms-sub', replied.size + ' of ' + texted.size + ' texted replied');
  } catch (e) { anSet('an-sms', '—'); anSet('an-sms-sub', 'no SMS data yet'); }
}

/* ── Charts ── */
function anChart(id, cfg) {
  if (anCharts[id]) { anCharts[id].destroy(); delete anCharts[id]; }
  const el = document.getElementById(id);
  if (!el || typeof Chart === 'undefined') return;
  anCharts[id] = new Chart(el, cfg);
}

function anAxes(extraY) {
  const border = anVar('--border'), text3 = anVar('--text3');
  return {
    x: { grid: { display: false }, ticks: { color: text3, font: { size: 10.5 } } },
    y: Object.assign({ grid: { color: border }, ticks: { color: text3, font: { size: 10.5 }, precision: 0 } }, extraY || {})
  };
}

function anRenderDaily(vol, now, fromDials) {
  const labels = [], ok = [], miss = [];
  for (let i = 13; i >= 0; i--) {
    const d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const d1 = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + 1);
    const day = vol.filter(v => v.t >= d0 && v.t < d1);
    const c = day.filter(v => v.ok).length;
    labels.push((d0.getMonth() + 1) + '/' + d0.getDate());
    ok.push(c); miss.push(day.length - c);
  }
  anChart('chart-daily', {
    type: 'bar',
    data: { labels, datasets: [
      { label: fromDials ? 'Answered' : 'Conversations', data: ok, backgroundColor: anVar('--brand'), stack: 's', borderRadius: 3 },
      { label: fromDials ? 'No answer' : 'No answer / voicemail', data: miss, backgroundColor: anVar('--border'), stack: 's', borderRadius: 3 }
    ]},
    options: { responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 11, color: anVar('--text2'), font: { size: 11 } } } },
      scales: (s => (s.x.stacked = true, s.y.stacked = true, s))(anAxes()) }
  });
  anSet('an-daily-note', fromDials
    ? 'Counting every dial attempt — answered calls in blue.'
    : 'From logged calls — per-attempt dial tracking starts with your next dialer call.');
}

function anRenderHour(vol, fromDials) {
  const hours = []; for (let h = 8; h <= 18; h++) hours.push(h);
  const total = hours.map(() => 0), ok = hours.map(() => 0);
  vol.forEach(v => {
    const i = hours.indexOf(v.t.getHours());
    if (i === -1) return;
    total[i]++; if (v.ok) ok[i]++;
  });
  const rates = hours.map((h, i) => total[i] ? Math.round(ok[i] / total[i] * 100) : null);
  const labels = hours.map(h => h === 12 ? '12p' : h > 12 ? (h - 12) + 'p' : h + 'a');
  anChart('chart-hour', {
    type: 'bar',
    data: { labels, datasets: [{ data: rates, backgroundColor: anVar('--brand'), borderRadius: 3 }] },
    options: { responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: ctx => ctx.parsed.y + '% (' + ok[ctx.dataIndex] + ' of ' + total[ctx.dataIndex] + ' dials)' } } },
      scales: anAxes({ suggestedMax: 50, ticks: { color: anVar('--text3'), font: { size: 10.5 }, callback: v => v + '%' } }) }
  });
  const n = total.reduce((a, b) => a + b, 0);
  let best = -1;
  rates.forEach((r, i) => { if (r !== null && total[i] >= 3 && r > 0 && (best === -1 || r > rates[best])) best = i; });
  const src = fromDials ? 'answer rate by hour, last 30 days' : 'connect rate by hour, all logged calls';
  anSet('an-hour-note', (n < 30 || best === -1)
    ? src.charAt(0).toUpperCase() + src.slice(1) + '. Gets sharper as you log more dials.'
    : src.charAt(0).toUpperCase() + src.slice(1) + '. Best window so far: around ' + labels[best].replace('a', ' am').replace('p', ' pm') + '.');
}

function anRenderOutcomes(d30) {
  const win = records.filter(r => new Date(r.created_at) >= d30);
  const cats = [
    ['Interested', anVar('--green')], ['Callback', anVar('--warm')], ['Not interested', anVar('--hot')],
    ['Voicemail', anVar('--cold')], ['No answer', anVar('--text3')]
  ];
  const labels = cats.map(c => c[0]), colors = cats.map(c => c[1]);
  const counts = cats.map(c => win.filter(r => r.outcome === c[0]).length);
  const none = win.filter(r => !r.outcome).length;
  if (none) { labels.push('Not logged'); colors.push(anVar('--border')); counts.push(none); }
  anChart('chart-outcomes', {
    type: 'bar',
    data: { labels, datasets: [{ data: counts, backgroundColor: colors, borderRadius: 3 }] },
    options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: anVar('--border') }, ticks: { color: anVar('--text3'), font: { size: 10.5 }, precision: 0 } },
        y: { grid: { display: false }, ticks: { color: anVar('--text2'), font: { size: 11 } } }
      } }
  });
}

function anRenderFunnel(contacts) {
  const el = document.getElementById('an-funnel');
  if (!el) return;
  const logged = records.length;
  const convos = records.filter(anIsConvo).length;
  const interested = records.filter(r => r.outcome === 'Interested').length;
  const meetings = contacts ? contacts.filter(c => AN_MEETING_STAGES.includes(c.stage)).length : null;
  const partners = contacts ? contacts.filter(c => AN_PARTNER_STAGES.includes(c.stage)).length : null;
  const steps = [
    ['Calls logged', logged, null], ['Conversations', convos, logged], ['Interested', interested, convos],
    ['Meetings set', meetings, interested], ['Partnerships', partners, meetings]
  ];
  el.innerHTML = steps.map((s, i) => {
    const val = s[1] === null ? '…' : s[1];
    const sub = (typeof s[1] === 'number' && typeof s[2] === 'number' && s[2] > 0)
      ? Math.round(s[1] / s[2] * 100) + '% of ' + steps[i - 1][0].toLowerCase() : '';
    return (i ? '<div style="color:var(--text3);font-size:17px;align-self:center">›</div>' : '') +
      `<div style="flex:1;min-width:88px;text-align:center">
        <div class="num" style="font-family:'Plus Jakarta Sans',sans-serif;font-size:22px;font-weight:800;color:var(--text)">${val}</div>
        <div style="font-size:10.5px;color:var(--text2);font-weight:700;text-transform:uppercase;letter-spacing:.6px;margin-top:2px">${s[0]}</div>
        <div style="font-size:10.5px;color:var(--text3);margin-top:2px;min-height:13px">${sub}</div>
      </div>`;
  }).join('');
}
