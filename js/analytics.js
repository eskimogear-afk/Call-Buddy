/* ═══════════════════════════════════════════════════════
   ANALYTICS PANEL
═══════════════════════════════════════════════════════ */
const CONNECTED_OUTCOMES = ['Interested', 'Not interested', 'Callback'];
const STALE_DAYS = 14;
const DAY_MS = 86400000;
let anCharts = {};
let anContacts = null;

function dialGoal() {
  const v = parseInt(localStorage.getItem('pitchlog_dial_goal'), 10);
  return v > 0 ? v : 50;
}

function changeDialGoal() {
  const v = parseInt(prompt('Daily dial goal:', dialGoal()), 10);
  if (v > 0) { localStorage.setItem('pitchlog_dial_goal', v); renderAnalytics(); }
}

function callDuration(r) { return r.duration_seconds || r.duration || 0; }

/* Dialer-logged calls can lack an outcome — treat ≥30s of recording as a connect. */
function isConnected(r) {
  if (CONNECTED_OUTCOMES.includes(r.outcome)) return true;
  if (r.outcome) return false;
  return callDuration(r) >= 30;
}

function callTime(r) { return new Date(r.created_at || r.call_date); }

function anSet(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }

function anPct(n, d) { return d ? Math.round(n / d * 100) + '%' : '—'; }

function renderAnalytics() {
  const empty = document.getElementById('analytics-empty');
  const body = document.getElementById('analytics-body');
  if (!records.length) { empty.classList.remove('hidden'); body.classList.add('hidden'); return; }
  empty.classList.add('hidden'); body.classList.remove('hidden');

  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const d7 = new Date(now - 7 * DAY_MS);
  const d14 = new Date(now - 14 * DAY_MS);
  const d30 = new Date(now - 30 * DAY_MS);

  const today = records.filter(r => callTime(r) >= startToday);
  anSet('an-dials', today.length);
  const goal = dialGoal();
  document.getElementById('an-goal-bar').style.width = Math.min(100, Math.round(today.length / goal * 100)) + '%';
  anSet('an-goal-lbl', 'goal ' + goal + (today.length >= goal ? ' — hit!' : ''));

  const win7 = records.filter(r => callTime(r) >= d7);
  const prev7 = records.filter(r => { const t = callTime(r); return t >= d14 && t < d7; });
  const conn7 = win7.filter(isConnected);
  anSet('an-connect', anPct(conn7.length, win7.length));
  const deltaEl = document.getElementById('an-connect-sub');
  const prevConn = prev7.filter(isConnected);
  if (win7.length >= 10 && prev7.length >= 10) {
    const d = Math.round(conn7.length / win7.length * 100 - prevConn.length / prev7.length * 100);
    deltaEl.textContent = (d >= 0 ? '+' : '') + d + ' pts vs prior week';
    deltaEl.style.color = d >= 0 ? '#059669' : 'var(--danger)';
  } else {
    deltaEl.textContent = conn7.length + ' of ' + win7.length + ' dials';
    deltaEl.style.color = 'var(--text3)';
  }

  const int7 = win7.filter(r => r.outcome === 'Interested');
  anSet('an-interested', anPct(int7.length, conn7.length));
  anSet('an-interested-sub', int7.length + ' of ' + conn7.length + ' connects');

  renderDailyChart(now);
  renderHourChart();
  renderOutcomeChart(d30);
  renderFunnel();

  loadAnalyticsContacts();
  loadAnalyticsFollowUps();
  loadSmsReplyRate();
}

async function loadAnalyticsFollowUps() {
  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) return;
    const r = await fetch('/api/follow-ups?status=pending&limit=500', { headers: { Authorization: 'Bearer ' + session.access_token } });
    const items = await r.json();
    if (!Array.isArray(items)) throw new Error('bad response');
    const now = new Date();
    const endToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const due = items.filter(f => new Date(f.scheduled_at) < endToday);
    const overdue = items.filter(f => new Date(f.scheduled_at) <= now);
    anSet('an-due', due.length);
    const sub = document.getElementById('an-due-sub');
    sub.textContent = overdue.length ? overdue.length + ' overdue' : 'nothing overdue';
    sub.style.color = overdue.length ? 'var(--danger)' : 'var(--text3)';
  } catch (e) { anSet('an-due', '—'); anSet('an-due-sub', ''); }
}

function heatPill(label, count, color, bg) {
  return `<span style="background:${bg};color:${color};font-size:12px;font-weight:600;padding:3px 10px;border-radius:99px">${label} ${count}</span>`;
}

async function loadAnalyticsContacts() {
  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) return;
    const r = await fetch('/api/contacts', { headers: { Authorization: 'Bearer ' + session.access_token } });
    const list = await r.json();
    if (!Array.isArray(list)) throw new Error('bad response');
    anContacts = list;
    const now = new Date();
    const open = list.filter(c => c.stage !== 'closed');
    const hotNoNext = open.filter(c => c.heat_score === 'Hot' && (!c.next_follow_up_at || new Date(c.next_follow_up_at) <= now));
    anSet('an-hotnonext', hotNoNext.length);
    document.getElementById('an-hotnonext').style.color = hotNoNext.length ? 'var(--danger)' : '';
    const heat = { Hot: 0, Warm: 0, Cold: 0 };
    list.forEach(c => { heat[heat.hasOwnProperty(c.heat_score) ? c.heat_score : 'Cold']++; });
    document.getElementById('an-heat').innerHTML =
      heatPill('Hot', heat.Hot, '#dc2626', '#fee2e2') +
      heatPill('Warm', heat.Warm, '#b45309', '#fef3c7') +
      heatPill('Cold', heat.Cold, '#4b5563', '#f3f4f6');
    const stale = open.filter(c => { const ref = c.last_called || c.created_at; return ref && now - new Date(ref) > STALE_DAYS * DAY_MS; });
    anSet('an-stale', stale.length);
    renderFunnel();
  } catch (e) {
    anSet('an-hotnonext', '—'); anSet('an-stale', '—');
    document.getElementById('an-heat').innerHTML = '<span class="stat-lbl">couldn’t load contacts</span>';
  }
}

async function loadSmsReplyRate() {
  try {
    const { data, error } = await db.from('messages').select('phone,direction').eq('user_id', currentUser.id);
    if (error || !data) throw error || new Error('no data');
    const texted = new Set(), replied = new Set();
    data.forEach(m => { if (m.direction === 'outbound') texted.add(m.phone); });
    data.forEach(m => { if (m.direction === 'inbound' && texted.has(m.phone)) replied.add(m.phone); });
    if (!texted.size) { anSet('an-sms', '—'); anSet('an-sms-sub', 'no texts sent yet'); return; }
    anSet('an-sms', Math.round(replied.size / texted.size * 100) + '%');
    anSet('an-sms-sub', replied.size + ' of ' + texted.size + ' texted replied');
  } catch (e) { anSet('an-sms', '—'); anSet('an-sms-sub', 'no SMS data yet'); }
}

/* ── Charts ── */
function makeChart(id, cfg) {
  if (anCharts[id]) { anCharts[id].destroy(); delete anCharts[id]; }
  const el = document.getElementById(id);
  if (!el || typeof Chart === 'undefined') return;
  anCharts[id] = new Chart(el, cfg);
}

function renderDailyChart(now) {
  const labels = [], conn = [], notConn = [];
  for (let i = 13; i >= 0; i--) {
    const d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const d1 = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + 1);
    const day = records.filter(r => { const t = callTime(r); return t >= d0 && t < d1; });
    const c = day.filter(isConnected).length;
    labels.push((d0.getMonth() + 1) + '/' + d0.getDate());
    conn.push(c); notConn.push(day.length - c);
  }
  makeChart('chart-daily', {
    type: 'bar',
    data: { labels, datasets: [
      { label: 'Connected', data: conn, backgroundColor: '#6366F1', stack: 's', borderRadius: 3 },
      { label: 'No answer / voicemail', data: notConn, backgroundColor: '#E5E7EB', stack: 's', borderRadius: 3 }
    ]},
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 12 } } } },
      scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, ticks: { precision: 0 }, grid: { color: '#F1F5F0' } } } }
  });
}

function renderHourChart() {
  const hours = []; for (let h = 8; h <= 18; h++) hours.push(h);
  const dials = hours.map(() => 0), conns = hours.map(() => 0);
  records.forEach(r => {
    const i = hours.indexOf(callTime(r).getHours());
    if (i === -1) return;
    dials[i]++; if (isConnected(r)) conns[i]++;
  });
  const rates = hours.map((h, i) => dials[i] ? Math.round(conns[i] / dials[i] * 100) : null);
  const labels = hours.map(h => h === 12 ? '12p' : h > 12 ? (h - 12) + 'p' : h + 'a');
  makeChart('chart-hour', {
    type: 'bar',
    data: { labels, datasets: [{ data: rates, backgroundColor: '#6366F1', borderRadius: 3 }] },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: ctx => ctx.parsed.y + '% (' + conns[ctx.dataIndex] + ' of ' + dials[ctx.dataIndex] + ' dials)' } } },
      scales: { x: { grid: { display: false } }, y: { suggestedMax: 50, ticks: { callback: v => v + '%' }, grid: { color: '#F1F5F0' } } } }
  });
  const note = document.getElementById('an-hour-note');
  const total = dials.reduce((a, b) => a + b, 0);
  let best = -1;
  rates.forEach((r, i) => { if (r !== null && dials[i] >= 3 && (best === -1 || r > rates[best]) && r > 0) best = i; });
  if (total < 30 || best === -1) note.textContent = 'All-time, 8am–6pm. Gets accurate as you log more calls.';
  else note.textContent = 'All-time, 8am–6pm. Best window so far: around ' + labels[best].replace('a', ' am').replace('p', ' pm') + '.';
}

function renderOutcomeChart(d30) {
  const win = records.filter(r => callTime(r) >= d30);
  const cats = [
    ['Interested', '#10B981'], ['Callback', '#F59E0B'], ['Not interested', '#EF4444'],
    ['Voicemail', '#60A5FA'], ['No answer', '#9CA3AF']
  ];
  const labels = cats.map(c => c[0]), colors = cats.map(c => c[1]);
  const counts = cats.map(c => win.filter(r => r.outcome === c[0]).length);
  const none = win.filter(r => !r.outcome).length;
  if (none) { labels.push('Not logged'); colors.push('#E5E7EB'); counts.push(none); }
  makeChart('chart-outcomes', {
    type: 'bar',
    data: { labels, datasets: [{ data: counts, backgroundColor: colors, borderRadius: 3 }] },
    options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { x: { ticks: { precision: 0 }, grid: { color: '#F1F5F0' } }, y: { grid: { display: false } } } }
  });
}

function renderFunnel() {
  const el = document.getElementById('an-funnel');
  const dials = records.length;
  const connects = records.filter(isConnected).length;
  const interested = records.filter(r => r.outcome === 'Interested').length;
  const appts = anContacts ? anContacts.filter(c => c.stage === 'appointment' || c.stage === 'closed').length : null;
  const closed = anContacts ? anContacts.filter(c => c.stage === 'closed').length : null;
  const steps = [
    ['Dials', dials, null], ['Connects', connects, dials], ['Interested', interested, connects],
    ['Appointments', appts, interested], ['Closed', closed, appts]
  ];
  el.innerHTML = steps.map((s, i) => {
    const val = s[1] === null ? '…' : s[1];
    const sub = (typeof s[1] === 'number' && typeof s[2] === 'number' && s[2] > 0)
      ? Math.round(s[1] / s[2] * 100) + '% of ' + steps[i - 1][0].toLowerCase() : '';
    return (i ? '<div style="color:var(--text3);font-size:18px;align-self:center">›</div>' : '') +
      `<div style="flex:1;min-width:90px;text-align:center">
        <div class="stat-val" style="font-size:26px">${val}</div>
        <div class="stat-lbl">${s[0]}</div>
        <div style="font-size:11px;color:var(--text3);margin-top:2px;min-height:14px">${sub}</div>
      </div>`;
  }).join('');
}
