// PitchLog Browser Dialer — Twilio Voice SDK 2.x
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

    twilioDevice.on('registered', () => setStatus('🟢 Ready to call'));
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
  }
}

async function makeCall() {
  const input = document.getElementById('dialer-number');
  const number = input ? input.value.trim() : '';
  if (!number) { alert('Enter a phone number first'); return; }
  if (!twilioDevice) { alert('Dialer not ready — please wait'); return; }
  if (twilioDevice.isBusy) { alert('Already on a call'); return; }

  const h = document.getElementById('btn-hangup');
  const c = document.getElementById('btn-call');

  try {
    setStatus('Calling...');
    currentCall = await twilioDevice.connect({ params: { To: number } });

    if (h) h.style.display = 'inline-block';
    if (c) c.style.display = 'none';
    setStatus('📞 On call...');

    currentCall.on('accept', () => setStatus('📞 Connected'));
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

function endCallUI() {
  const h = document.getElementById('btn-hangup');
  const c = document.getElementById('btn-call');
  if (h) h.style.display = 'none';
  if (c) c.style.display = 'inline-block';
  currentCall = null;
  setStatus('✅ Call ended — AI logging...');
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
      setStatus('🟢 Ready to call');
      if (typeof renderLog === 'function') renderLog();
      if (typeof refreshDashboard === 'function') refreshDashboard();
      return;
    }
  } catch (e) { console.error('Poll error:', e); }
  setTimeout(() => pollForCallRecord(startedAt, attempt + 1), 3000);
}

function hangUp() {
  if (currentCall) currentCall.disconnect();
  else if (twilioDevice) twilioDevice.disconnectAll();
}