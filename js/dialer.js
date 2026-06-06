// PitchLog Browser Dialer
let twilioDevice = null;

async function initTwilioDevice() {
  try {
    const { data: { session } } = await db.auth.getSession();
    const res = await fetch('/api/twilio-token', {
      headers: { 'Authorization': `Bearer ${session?.access_token}` }
    });
    const data = await res.json();
    if (!data.token) throw new Error('No token returned');

    twilioDevice = new Twilio.Device(data.token, { codecPreferences: ['opus', 'pcmu'] });

    twilioDevice.on('ready', () => {
      const el = document.getElementById('dialer-status');
      if (el) el.textContent = '🟢 Ready to call';
    });
    twilioDevice.on('error', (err) => {
      const el = document.getElementById('dialer-status');
      if (el) el.textContent = '🔴 ' + err.message;
    });
    twilioDevice.on('connect', () => {
      const h = document.getElementById('btn-hangup');
      const c = document.getElementById('btn-call');
      const s = document.getElementById('dialer-status');
      if (h) h.style.display = 'inline-block';
      if (c) c.style.display = 'none';
      if (s) s.textContent = '📞 On call...';
    });
    twilioDevice.on('disconnect', () => {
      const h = document.getElementById('btn-hangup');
      const c = document.getElementById('btn-call');
      const s = document.getElementById('dialer-status');
      if (h) h.style.display = 'none';
      if (c) c.style.display = 'inline-block';
      if (s) s.textContent = '✅ Call ended — AI logging...';
      setTimeout(() => {
        const el = document.getElementById('dialer-status');
        if (el) el.textContent = '🟢 Ready to call';
        if (typeof renderLog === 'function') renderLog();
        if (typeof refreshDashboard === 'function') refreshDashboard();
      }, 5000);
    });
  } catch (err) {
    console.error('Dialer init error:', err);
    const el = document.getElementById('dialer-status');
    if (el) el.textContent = '⚠️ Dialer unavailable';
  }
}

function makeCall() {
  const number = document.getElementById('dialer-number').value.trim();
  if (!number) { alert('Enter a phone number first'); return; }
  if (!twilioDevice) { alert('Dialer not ready — please wait'); return; }
  twilioDevice.connect({ To: number });
}

function hangUp() {
  if (twilioDevice) twilioDevice.disconnectAll();
}
