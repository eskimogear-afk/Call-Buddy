// PitchLog Browser Dialer
let twilioDevice = null;

async function initTwilioDevice() {
  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
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
      document.getElementById('btn-hangup').style.display = 'inline-block';
      document.getElementById('btn-call').style.display = 'none';
      document.getElementById('dialer-status').textContent = '📞 On call...';
    });
    twilioDevice.on('disconnect', () => {
      document.getElementById('btn-hangup').style.display = 'none';
      document.getElementById('btn-call').style.display = 'inline-block';
      document.getElementById('dialer-status').textContent = '✅ Call ended — AI logging...';
      setTimeout(() => {
        const el = document.getElementById('dialer-status');
        if (el) el.textContent = '🟢 Ready to call';
        loadCallLog();
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
