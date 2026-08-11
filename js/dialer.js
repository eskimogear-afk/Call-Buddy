// Aevaa Browser Dialer — Twilio Voice SDK 2.x
let twilioDevice = null;
let currentCall = null;

function setStatus(msg) {
  const el = document.getElementById('dialer-status');
  if (el) el.textContent = msg;
}

async function initTwilioDevice() {
  try {
    if (typeof Twilio === 'undefined' || !Twilio.Device) {
      setStatus('⚠️ Voice SDK not loaded');
      return;
    }
    setStatus('Connecting...');

    const { data: { session } } = await db.auth.getSession();
    const res = await fetch('/api/twilio-token', {
      headers: { 'Authorization': `Bearer ${session?.access_token}` }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Token request failed (' + res.status + ')');
    if (!data.token) throw new Error('No token returned');

    twilioDevice = new Twilio.Device(data.token, {
      codecPreferences: ['opus', 'pcmu'],
      logLevel: 'error'
    });

    twilioDevice.on('registered', () => {
      setStatus('🟢 Ready to call');
      const retryBtn = document.getElementById('btn-dialer-retry');
      if (retryBtn) retryBtn.style.display = 'none';
    });

    // Incoming calls — ring the browser, let the user answer or decline
    twilioDevice.on('incoming', (call) => {
      const from = call.parameters.From || 'Unknown';
      currentCall = call;
      setStatus('📞 Incoming call: ' + from);
      // Auto caller-ID screen-pop (handled in the app): identify who's calling
      try { window.dispatchEvent(new CustomEvent('cb:incoming-call', { detail: { from, call } })); } catch (e) {}

      const c = document.getElementById('btn-call');
      const h = document.getElementById('btn-hangup');
      if (c) {
        c.textContent = '✅ Answer';
        c.onclick = () => call.accept();
        c.style.display = 'inline-block';
      }
      if (h) {
        h.textContent = 'Decline';
        h.style.display = 'inline-block';
        h.onclick = () => { call.reject(); restoreDialerUI(); setStatus('🟢 Ready to call'); };
      }

      call.on('accept', () => {
        setStatus('📞 Connected: ' + from);
        if (c) c.style.display = 'none';
        if (h) { h.textContent = 'Hang Up'; h.onclick = hangUp; }
        try { window.dispatchEvent(new CustomEvent('cb:incoming-answered')); } catch (e) {}
      });
      call.on('disconnect', () => { restoreDialerUI(); endCallUI(); try { window.dispatchEvent(new CustomEvent('cb:incoming-cleared')); } catch (e) {} });
      call.on('cancel', () => { restoreDialerUI(); currentCall = null; setStatus('Missed call: ' + from); try { window.dispatchEvent(new CustomEvent('cb:incoming-cleared')); } catch (e) {} });
      call.on('reject', () => { restoreDialerUI(); currentCall = null; try { window.dispatchEvent(new CustomEvent('cb:incoming-cleared')); } catch (e) {} });
      // Mirror the outbound path: an errored incoming call must also clear the screen-pop
      call.on('error', (err) => { console.error('Incoming call error:', err); restoreDialerUI(); currentCall = null; setStatus('🔴 ' + (err.message || 'Call error')); try { window.dispatchEvent(new CustomEvent('cb:incoming-cleared')); } catch (e) {} });
    });
    twilioDevice.on('registering', () => setStatus('Registering...'));
    twilioDevice.on('unregistered', () => setStatus('⚪ Offline'));
    twilioDevice.on('error', (err) => {
      console.error('Twilio device error:', err);
      setStatus('🔴 ' + (err.message || err.code || 'Device error'));
    });

    // Refresh token before it expires so the device stays alive
    twilioDevice.on('tokenWillExpire', async () => {
      try {
        const { data: { session } } = await db.auth.getSession();
        const r = await fetch('/api/twilio-token', {
          headers: { 'Authorization': `Bearer ${session?.access_token}` }
        });
        const d = await r.json();
        if (d.token) twilioDevice.updateToken(d.token);
      } catch (e) { console.error('Token refresh failed:', e); }
    });

    await twilioDevice.register();
    loadMyNumbers();
    loadNumberUsage();
  } catch (err) {
    console.error('Dialer init error:', err);
    setStatus('⚠️ ' + (err.message || 'Dialer unavailable'));
    const retryBtn = document.getElementById('btn-dialer-retry');
    if (retryBtn) retryBtn.style.display = 'inline-block';
  }
}

async function retryDialer() {
  const retryBtn = document.getElementById('btn-dialer-retry');
  if (retryBtn) retryBtn.style.display = 'none';
  twilioDevice = null;
  currentCall = null;
  await initTwilioDevice();
}

/* ── Local-presence caller ID: choose which of your numbers a call goes from ──
   'auto' matches the lead's area code to one of your numbers (falls back to your
   primary); or lock it to a specific number. Twilio enforces number ownership. */
window.callerIdMode = (function () { try { return localStorage.getItem('cidMode') || 'auto'; } catch (e) { return 'auto'; } })();

async function loadMyNumbers() {
  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session) return;
    const r = await fetch('/api/contacts?resource=numbers', { headers: { Authorization: 'Bearer ' + session.access_token } });
    const d = await r.json();
    window.myTwilioNumbers = d.numbers || [];
    renderCallerIdSelect();
  } catch (e) { /* non-fatal — falls back to primary caller ID */ }
}

function fmtCid(p) { const t = String(p || '').replace(/\D/g, '').slice(-10); return t.length === 10 ? '(' + t.slice(0, 3) + ') ' + t.slice(3, 6) + '-' + t.slice(6) : (p || ''); }

function renderCallerIdSelect() {
  const sel = document.getElementById('callerid-select');
  if (!sel) return;
  const nums = window.myTwilioNumbers || [];
  sel.innerHTML = '<option value="auto">🔀 Auto — local area code</option>' +
    nums.map(n => {
      const region = String(n.name || '').split('—').pop().trim().replace(/\s*\(\d+\)\s*$/, '').trim();
      return `<option value="${n.phone}">${fmtCid(n.phone)}${region ? ' · ' + region : ''}</option>`;
    }).join('');
  const mode = window.callerIdMode || 'auto';
  sel.value = (mode === 'auto' || nums.some(n => n.phone === mode)) ? mode : 'auto';
  updateCallerIdIndicator();
}

function setCallerIdMode(v) {
  window.callerIdMode = v;
  try { localStorage.setItem('cidMode', v); } catch (e) {}
  updateCallerIdIndicator();
}

// Overlay area codes that cover the SAME metro — a number in any of these is
// "local" to a lead in any other (e.g. a 786 number is local to a 305 lead).
const CID_REGIONS = [['305', '786'], ['754', '954'], ['239', '941'], ['561'], ['772'], ['407', '321', '689'], ['813', '727']];
function _cidSameRegion(a, b) { return a === b || CID_REGIONS.some(g => g.includes(a) && g.includes(b)); }

/* ── Number warm-up: ramp a new number's daily call volume so it builds
   reputation without getting flagged. Each non-primary number gets a daily cap
   that grows over ~2 weeks; once it hits the cap for the day, Auto mode routes
   that area's calls to the mature primary instead (a hard stop on overuse). ── */
const WARMUP_RAMP = [[3, 25], [7, 50], [11, 80], [14, 110]]; // [throughDay, dailyCap]; after day 14 = mature (no cap)
window.numberUsageToday = window.numberUsageToday || {};

function _warmupStart(num) {
  const primary = (window.userProfile && window.userProfile.twilio_phone_number) || '';
  if (!num || num === primary) return null; // primary is the mature workhorse — never capped
  const key = 'warmup_' + num;
  let s = null; try { s = localStorage.getItem(key); } catch (e) {}
  if (!s) { s = new Date().toISOString(); try { localStorage.setItem(key, s); } catch (e) {} }
  return s;
}
function warmupInfo(num) {
  const used = (window.numberUsageToday || {})[num] || 0;
  const start = _warmupStart(num);
  if (!start) return { mature: true, cap: null, day: null, used };
  const day = Math.floor((Date.now() - new Date(start).getTime()) / 86400000) + 1;
  let cap = null;
  for (const [through, c] of WARMUP_RAMP) { if (day <= through) { cap = c; break; } }
  return { mature: cap === null, cap, day, used };
}
function numberCapped(num) {
  const w = warmupInfo(num);
  return !w.mature && w.cap != null && w.used >= w.cap;
}
async function loadNumberUsage() {
  try {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const rows = (typeof fetchAllDials === 'function') ? await fetchAllDials(start.toISOString(), 'from_number') : [];
    const counts = {};
    rows.forEach(d => { if (d.from_number) counts[d.from_number] = (counts[d.from_number] || 0) + 1; });
    window.numberUsageToday = counts;
    if (typeof updateCallerIdIndicator === 'function') updateCallerIdIndicator();
  } catch (e) { /* non-fatal */ }
}

function pickCallerId(leadNumber) {
  const primary = (window.userProfile && window.userProfile.twilio_phone_number) || '';
  const mode = window.callerIdMode || 'auto';
  if (mode && mode !== 'auto' && /^\+?\d/.test(mode)) return mode;   // manual lock overrides warm-up
  const ac = s => String(s || '').replace(/\D/g, '').slice(-10, -7);  // area code = first 3 of last 10 digits
  const leadAC = ac(leadNumber);
  const owned = (window.myTwilioNumbers || []).map(n => n.phone || n);
  const local = owned.filter(p => ac(p) === leadAC)                                     // exact area code
    .concat(owned.filter(p => _cidSameRegion(ac(p), leadAC) && ac(p) !== leadAC));      // then same metro (overlay)
  const open = local.find(p => !numberCapped(p));   // a local number under its warm-up cap today
  if (open) return open;
  if (local.length && primary) return primary;       // local number(s) maxed → overflow to the mature primary
  return local[0] || primary || '';
}

function updateCallerIdIndicator() {
  const el = document.getElementById('dialer-caller-id');
  if (!el) return;
  const num = (document.getElementById('dialer-number') || {}).value || '';
  const cid = pickCallerId(num);
  if (!cid) { el.innerHTML = ''; return; }
  const primary = (window.userProfile && window.userProfile.twilio_phone_number) || '';
  const auto = (window.callerIdMode || 'auto') === 'auto';
  const ac = s => String(s || '').replace(/\D/g, '').slice(-10, -7);
  const owned = (window.myTwilioNumbers || []).map(n => n.phone || n);
  const localForLead = owned.find(p => ac(p) === ac(num)) || owned.find(p => _cidSameRegion(ac(p), ac(num)) && ac(p) !== ac(num));
  const w = warmupInfo(cid);
  let badge = '';
  if (auto && localForLead && cid === primary && localForLead !== primary && numberCapped(localForLead)) {
    badge = ' · (' + ac(localForLead) + ') maxed today';   // local number hit its warm-up cap → using primary
  } else if (!w.mature && w.cap != null) {
    badge = ` · warming ${w.used}/${w.cap} (day ${w.day})`;
  } else if (auto && cid !== primary && localForLead === cid) {
    badge = ' · local';
  }
  el.innerHTML = '📤 ' + fmtCid(cid) + (badge ? `<span style="color:var(--brand-mid);font-weight:600">${badge}</span>` : '');
}

async function makeCall() {
  const input = document.getElementById('dialer-number');
  const number = input ? input.value.trim() : '';
  if (!number) { alert('Enter a phone number first'); return; }
  // Do Not Call guard — block suppressed numbers before connecting
  if (typeof isDNC === 'function' && isDNC(number)) {
    setStatus('🚫 On Do Not Call list — blocked');
    alert('This number is on your Do Not Call list and was not dialed.\n\nRemove it under Settings → Do Not Call list if this is a mistake.');
    return;
  }
  // Calling-hours guard (Compliance Mode) — block outside 8am–9pm prospect-local
  if (typeof complianceOn === 'function' && complianceOn() && typeof callingHoursCheck === 'function') {
    const chk = callingHoursCheck(number);
    if (!chk.ok && !chk.unknown) {
      setStatus('⛔ Outside calling hours — blocked');
      alert('Compliance Mode blocked this call.\n\nIt is ' + chk.label + ' for this number — outside the federal 8:00am–9:00pm calling window in their local time.\n\nTry again during their business hours.');
      return;
    }
  }
  // Free-plan call cap applies to the dialer too, not just the recorder
  const _plan = window.userProfile?.plan || 'free';
  if (_plan === 'free' && (window.userProfile?.calls_this_month || 0) >= (window.FREE_LIMIT || 25)) {
    if (typeof showUpgradeModal === 'function') showUpgradeModal();
    return;
  }
  if (!twilioDevice) { alert('Dialer not ready — please wait'); return; }
  if (twilioDevice.isBusy) { alert('Already on a call'); return; }

  const h = document.getElementById('btn-hangup');
  const c = document.getElementById('btn-call');

  try {
    setStatus('Calling...');
    const cid = pickCallerId(number);
    currentCall = await twilioDevice.connect({ params: { To: number, Cid: cid } });
    window.numberUsageToday[cid] = (window.numberUsageToday[cid] || 0) + 1;   // count toward today's warm-up usage
    window.__callStartedAt = Date.now();
    // Pickup-rate tracking: one row per dial attempt; marked answered when
    // the recording-born call row appears (recordings only exist on answer)
    try {
      const { data: dialRow } = await db.from('dials')
        .insert({ user_id: window.currentUser?.id, phone: number, from_number: cid }).select('id').single();
      window.__lastDialId = dialRow?.id || null;
    } catch (e) { window.__lastDialId = null; }

    if (h) h.style.display = 'inline-block';
    if (c) c.style.display = 'none';
    setStatus('📞 On call...');
    // Kick off pre-call intelligence while it rings (no-op if app lacks the handler)
    window.dispatchEvent(new CustomEvent('cb:call-started', { detail: { number } }));

    currentCall.on('accept', () => { setStatus('📞 Connected'); startDialerCopilot(currentCall); });
    currentCall.on('disconnect', endCallUI);
    currentCall.on('cancel', endCallUI);
    currentCall.on('reject', endCallUI);
    currentCall.on('error', (err) => {
      console.error('Call error:', err);
      setStatus('🔴 ' + (err.message || 'Call error'));
      endCallUI();
    });
  } catch (err) {
    console.error('makeCall error:', err);
    setStatus('🔴 ' + (err.message || 'Call failed'));
    endCallUI();
  }
}

function restoreDialerUI() {
  const c = document.getElementById('btn-call');
  const h = document.getElementById('btn-hangup');
  if (c) { c.textContent = 'Call'; c.onclick = makeCall; c.style.display = 'inline-block'; }
  if (h) { h.textContent = 'Hang Up'; h.onclick = hangUp; h.style.display = 'none'; }
}

function endCallUI() {
  stopDialerCopilot();
  const h = document.getElementById('btn-hangup');
  const c = document.getElementById('btn-call');
  if (h) h.style.display = 'none';
  if (c) c.style.display = 'inline-block';
  currentCall = null;
  setStatus('✅ Call ended — AI logging...');
  trackCallMinutes();
  window.dispatchEvent(new CustomEvent('cb:call-ended'));
  pollForCallRecord(Date.now(), 0);
}

async function pollForCallRecord(startedAt, attempt) {
  if (attempt >= 20) {
    setStatus('🟢 Ready to call');
    if (typeof renderLog === 'function') renderLog();
    if (typeof refreshDashboard === 'function') refreshDashboard();
    return;
  }
  try {
    const since = new Date(startedAt - 10000).toISOString();
    const { data } = await db.from('calls').select('id').gte('created_at', since).limit(1);
    if (data && data.length > 0) {
      if (window.__lastDialId) {
        db.from('dials').update({ answered: true }).eq('id', window.__lastDialId).then(() => {});
        window.__lastDialId = null;
      }
      setStatus('🟢 Ready to call');
      if (typeof renderLog === 'function') renderLog();
      if (typeof refreshDashboard === 'function') refreshDashboard();
      // Keep watching for the AI analysis + suggested follow-up popup
      pollForAnalysis(data[0].id, 0);
      return;
    }
  } catch (e) { console.error('Poll error:', e); }
  setTimeout(() => pollForCallRecord(startedAt, attempt + 1), 3000);
}

// After the call record exists, wait for transcription + AI analysis to finish,
// then let the app surface the AI-suggested follow-up confirmation popup
async function pollForAnalysis(callId, attempt) {
  if (attempt >= 25) return; // ~100s budget
  try {
    const { data } = await db.from('calls').select('id, transcript').eq('id', callId).single();
    const t = String(data?.transcript || '');
    if (t && !t.startsWith('PENDING:')) {
      if (typeof renderLog === 'function') renderLog();
      if (typeof refreshDashboard === 'function') refreshDashboard();
      window.dispatchEvent(new CustomEvent('cb:analysis-ready', { detail: { callId } }));
      return;
    }
  } catch (e) { console.error('Analysis poll error:', e); }
  setTimeout(() => pollForAnalysis(callId, attempt + 1), 4000);
}

function hangUp() {
  if (currentCall) currentCall.disconnect();
  else if (twilioDevice) twilioDevice.disconnectAll();
}

// ── Minute metering: report call duration, surface bundle overage ──────────
async function trackCallMinutes() {
  const started = window.__callStartedAt;
  window.__callStartedAt = null;
  if (!started) return;
  const mins = Math.max(0.1, Math.ceil((Date.now() - started) / 6000) / 10); // round up to 0.1 min
  try {
    const { data: { session } } = await db.auth.getSession();
    const r = await fetch('/api/contacts?resource=usage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token },
      body: JSON.stringify({ minutes: mins })
    });
    const u = await r.json();
    window.__usageThisPeriod = u;
    if (typeof renderUsageMeter === 'function') renderUsageMeter();
    if (u.overage && !window.__overageToastShown) {
      window.__overageToastShown = true;
      showOverageToast(u);
    }
  } catch (e) { console.warn('usage tracking failed', e); }
}

function showOverageToast(u) {
  const t = document.createElement('div');
  t.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9999;max-width:340px;padding:14px 18px;border-radius:10px;border:1px solid var(--warm);background:var(--bg2);color:var(--text);font-size:13px;line-height:1.5;box-shadow:0 8px 28px rgba(0,0,0,.5)';
  t.innerHTML = '⚠️ <strong>You\'ve used your included ' + (u.included || 0).toLocaleString() + ' dialer minutes this month.</strong><br><span style="color:var(--text2)">Calls keep working — additional minutes bill at $0.03/min on your next invoice.</span>';
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 9000);
}

/* ════════════ Live in-call co-pilot for the browser dialer ════════════
   Captures BOTH sides of the call (Twilio local + remote streams), streams
   to Deepgram for live transcription, and every ~6s asks Claude what to say
   next — shown in a floating card. All best-effort: any failure leaves the
   call working normally. */
let dgStop = null, dgTranscript = '', dgAssistTimer = null, dgLastLen = 0, dgAssistBusy = false, dgLastFire = 0;

async function startDialerCopilot(call) {
  try {
    const streams = [];
    try { const l = call.getLocalStream && call.getLocalStream(); if (l) streams.push(l); } catch (e) {}
    try { const r = call.getRemoteStream && call.getRemoteStream(); if (r) streams.push(r); } catch (e) {}
    if (!streams.length) { console.warn('copilot: no call streams'); return; }

    const { data: { session } } = await db.auth.getSession();
    const tr = await fetch('/api/contacts?resource=dg-token', { headers: { Authorization: 'Bearer ' + session.access_token } });
    const tok = await tr.json();
    if (!tok.token) { console.warn('copilot: no token'); return; }

    const ws = new WebSocket('wss://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&interim_results=false&encoding=linear16&sample_rate=16000&channels=1&endpointing=300', ['token', tok.token]);
    const AC = window.AudioContext || window.webkitAudioContext;
    const ac = new AC({ sampleRate: 16000 });
    try { await ac.resume(); } catch (e) {}
    const proc = ac.createScriptProcessor(4096, 1, 1);
    streams.forEach(st => { try { ac.createMediaStreamSource(st).connect(proc); } catch (e) {} });
    const mute = ac.createGain(); mute.gain.value = 0;
    proc.connect(mute); mute.connect(ac.destination);
    proc.onaudioprocess = (e) => {
      if (ws.readyState !== 1) return;
      const f = e.inputBuffer.getChannelData(0);
      const i16 = new Int16Array(f.length);
      for (let i = 0; i < f.length; i++) { const x = Math.max(-1, Math.min(1, f[i])); i16[i] = x < 0 ? x * 32768 : x * 32767; }
      ws.send(i16.buffer);
    };
    ws.onmessage = (m) => {
      try { const j = JSON.parse(m.data); const t = j.channel?.alternatives?.[0]?.transcript; if (t && t.trim()) { dgTranscript += t.trim() + ' '; const tx = document.getElementById('dco-transcript'); if (tx) { tx.textContent = dgTranscript.slice(-500).trim(); tx.scrollTop = tx.scrollHeight; } scheduleDialerAssist(); } } catch (e) {}
    };
    ws.onerror = (e) => console.warn('copilot ws error', e);

    dgStop = () => {
      try { proc.disconnect(); mute.disconnect(); } catch (e) {}
      try { ac.close(); } catch (e) {}
      try { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'CloseStream' })); ws.close(); } catch (e) {}
    };
    dgTranscript = ''; dgLastLen = 0; dgLastFire = 0;
    const card = document.getElementById('dialer-copilot');
    if (card) { card.classList.remove('hidden'); const tx0 = document.getElementById('dco-transcript'); if (tx0) tx0.textContent = 'Listening to your call…'; const sy0 = document.getElementById('dco-say'); if (sy0) sy0.textContent = 'Coaching appears here as you talk.'; }
  } catch (e) { console.warn('copilot start failed', e); }
}

function stopDialerCopilot() {
  if (dgAssistTimer) { clearInterval(dgAssistTimer); dgAssistTimer = null; }
  if (dgStop) { try { dgStop(); } catch (e) {} dgStop = null; }
  document.getElementById('dialer-copilot')?.classList.add('hidden');
}

// Debounced: fires ~1.1s after the speaker pauses (event-driven, not a slow poll)
function scheduleDialerAssist() {
  if (dgAssistTimer) clearTimeout(dgAssistTimer);
  dgAssistTimer = setTimeout(runDialerAssist, 1100);
}
async function runDialerAssist() {
  const t = (dgTranscript || '').trim();
  const now = Date.now();
  if (dgAssistBusy || t.length < 20 || t.length - dgLastLen < 18 || now - dgLastFire < 2500) return;
  dgLastFire = now; dgLastLen = t.length; dgAssistBusy = true;
  try {
    const { data: { session } } = await db.auth.getSession();
    const r = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token }, body: JSON.stringify({ type: 'live_assist', transcript: t, lo_rates: (typeof loRatesString === 'function' ? loRatesString() : '') }) });
    const d = await r.json();
    if (r.ok && d.say_now) {
      const say = document.getElementById('dco-say'); if (say) { say.textContent = d.say_now; const sug = say.closest('.dco-suggestion'); if (sug) { sug.style.animation = 'none'; void sug.offsetWidth; sug.style.animation = 'dcoFlash .6s ease'; } }
      const obj = document.getElementById('dco-obj');
      if (obj) { if (d.objection) { obj.textContent = '⚠ ' + d.objection; obj.classList.remove('hidden'); } else obj.classList.add('hidden'); }
      const tip = document.getElementById('dco-tip');
      if (tip) { if (d.tip) { tip.textContent = '→ ' + d.tip; tip.classList.remove('hidden'); } else tip.classList.add('hidden'); }
    }
  } catch (e) {}
  dgAssistBusy = false;
}
