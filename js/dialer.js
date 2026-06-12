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
      });
      call.on('disconnect', () => { restoreDialerUI(); endCallUI(); });
      call.on('cancel', () => { restoreDialerUI(); currentCall = null; setStatus('Missed call: ' + from); });
      call.on('reject', () => { restoreDialerUI(); currentCall = null; });
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
    currentCall = await twilioDevice.connect({ params: { To: number } });
    window.__callStartedAt = Date.now();
    // Pickup-rate tracking: one row per dial attempt; marked answered when
    // the recording-born call row appears (recordings only exist on answer)
    try {
      const { data: dialRow } = await db.from('dials')
        .insert({ user_id: window.currentUser?.id, phone: number }).select('id').single();
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
      try { const j = JSON.parse(m.data); const t = j.channel?.alternatives?.[0]?.transcript; if (t && t.trim()) { dgTranscript += t.trim() + ' '; scheduleDialerAssist(); } } catch (e) {}
    };
    ws.onerror = (e) => console.warn('copilot ws error', e);

    dgStop = () => {
      try { proc.disconnect(); mute.disconnect(); } catch (e) {}
      try { ac.close(); } catch (e) {}
      try { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'CloseStream' })); ws.close(); } catch (e) {}
    };
    dgTranscript = ''; dgLastLen = 0; dgLastFire = 0;
    const card = document.getElementById('dialer-copilot');
    if (card) { card.classList.remove('hidden'); document.getElementById('dco-say').textContent = 'Listening to your call…'; }
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
      const say = document.getElementById('dco-say'); if (say) say.textContent = d.say_now;
      const obj = document.getElementById('dco-obj');
      if (obj) { if (d.objection) { obj.textContent = '⚠ ' + d.objection; obj.classList.remove('hidden'); } else obj.classList.add('hidden'); }
      const tip = document.getElementById('dco-tip');
      if (tip) { if (d.tip) { tip.textContent = '→ ' + d.tip; tip.classList.remove('hidden'); } else tip.classList.add('hidden'); }
    }
  } catch (e) {}
  dgAssistBusy = false;
}
