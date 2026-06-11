/* ═══════════════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════════════ */
let currentUser = null;
let userProfile = null;
let records = [];
let isRecording = false;
let mediaRecorder = null;
let recognition = null;
let timerInterval = null;
let seconds = 0;
let fullTranscript = '';
let selectedUpgradeTier = 'pro';
let selectedBillingInterval = 'monthly';

function isPaidPlan(plan) {
  return plan === 'starter' || plan === 'pro' || plan === 'team';
}

function getCallLimit(plan) {
  return PLAN_LIMITS[plan] ?? FREE_LIMIT;
}

function hasUnlimitedCalls(plan) {
  return getCallLimit(plan) === Infinity;
}

/* ═══════════════════════════════════════════════════════
   INIT - check if already logged in
═══════════════════════════════════════════════════════ */
(async () => {
  if (SUPABASE_URL === 'YOUR_SUPABASE_PROJECT_URL') return; // not configured yet
  try {
    const { data: { session } } = await db.auth.getSession();
    if (session?.user) {
      currentUser = session.user;
      await loadProfile();
      enterApp();
    } else {
      const params = new URLSearchParams(window.location.search);
      if (params.get('signup') === '1') showAuthModal('signup');
      else if (params.get('login') === '1') showAuthModal('login');
      else window.location.href = '/?login=1';
    }
    db.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && session?.user) {
        currentUser = session.user;
        await loadProfile();
        enterApp();
      } else if (event === 'SIGNED_OUT') {
        currentUser = null; userProfile = null; records = [];
        window.location.href = '/';
      }
    });
  } catch(e) { console.warn('Supabase not configured yet:', e.message); }
})();

/* ═══════════════════════════════════════════════════════
   AUTH
═══════════════════════════════════════════════════════ */
let authMode = 'signup';

function showAuthModal(mode) {
  authMode = mode;
  const isLogin = mode === 'login';
  document.getElementById('auth-title').textContent = isLogin ? 'Welcome back' : 'Create your account';
  document.getElementById('auth-sub').textContent = isLogin ? 'Good to have you back.' : 'Free forever. No credit card needed.';
  document.getElementById('auth-btn').textContent = isLogin ? 'Log in' : 'Create account';
  document.getElementById('name-row').style.display = isLogin ? 'none' : '';
  document.getElementById('auth-switch').innerHTML = isLogin
    ? 'New here? <span onclick="toggleAuth()">Create account</span>'
    : 'Already have an account? <span onclick="toggleAuth()">Log in</span>';
  document.getElementById('auth-alert').classList.add('hidden');
  document.getElementById('auth-modal').classList.remove('hidden');
}

function toggleAuth() {
  showAuthModal(authMode === 'login' ? 'signup' : 'login');
}

async function handleAuth() {
  if (SUPABASE_URL === 'YOUR_SUPABASE_PROJECT_URL') {
    showAlert('auth-alert', '⚠️ Supabase is not configured yet. Open index.html and add your SUPABASE_URL and SUPABASE_ANON_KEY. See README for instructions.');
    return;
  }
  const email = document.getElementById('a-email').value.trim();
  const pass = document.getElementById('a-pass').value;
  const name = document.getElementById('a-name').value.trim();
  document.getElementById('auth-alert').classList.add('hidden');
  if (!email || !pass) { showAlert('auth-alert', 'Please fill in email and password.'); return; }
  if (authMode === 'signup' && !name) { showAlert('auth-alert', 'Please enter your name.'); return; }
  if (pass.length < 6) { showAlert('auth-alert', 'Password must be at least 6 characters.'); return; }
  const btn = document.getElementById('auth-btn');
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner"></div> ' + (authMode === 'login' ? 'Logging in...' : 'Creating account...');
  try {
    let result;
    if (authMode === 'signup') {
      result = await db.auth.signUp({ email, password: pass, options: { data: { full_name: name } } });
      if (result.error) throw result.error;
      if (result.data.user && !result.data.session) {
        showAlert('auth-alert', '✓ Check your email to confirm your account, then log in.');
        btn.disabled = false; btn.textContent = 'Create account'; return;
      }
    } else {
      result = await db.auth.signInWithPassword({ email, password: pass });
      if (result.error) throw result.error;
    }
    closeModal('auth-modal');
    // Explicitly route to dashboard after successful auth
    if (result?.data?.user) {
      currentUser = result.data.user;
      await loadProfile();
      enterApp();
      if (authMode === 'signup') {
        setTimeout(() => {
          const tip = document.createElement('div');
          tip.style.cssText = 'position:fixed;bottom:24px;right:24px;background:var(--brand);color:#fff;padding:16px 20px;border-radius:var(--radius);font-size:14px;max-width:320px;box-shadow:0 8px 24px rgba(99,102,241,.4);z-index:9999;line-height:1.6';
          tip.innerHTML = '<strong>Welcome to PitchLog!</strong><br>Click <strong>New call</strong> in the sidebar, hit record, and make your first call on speaker. The AI handles everything else.';
          document.body.appendChild(tip);
          setTimeout(() => tip.remove(), 8000);
        }, 800);
      }
    }
  } catch(e) {
    showAlert('auth-alert', e.message || 'Something went wrong. Please try again.');
    btn.disabled = false;
    btn.textContent = authMode === 'login' ? 'Log in' : 'Create account';
  }
}

async function logout() {
  await db.auth.signOut();
}

/* ═══════════════════════════════════════════════════════
   PROFILE & DATA LOADING
═══════════════════════════════════════════════════════ */
async function loadProfile() {
  try {
    const { data } = await db.from('profiles').select('*').eq('id', currentUser.id).single();
    userProfile = data;
  } catch(e) { console.warn('Profile load error:', e); }
}

async function loadRecords() {
  try {
    const { data, error } = await db.from('calls').select('*').eq('user_id', currentUser.id).order('created_at', { ascending: false });
    if (error) throw error;
    records = data || [];
  } catch(e) { console.warn('Records load error:', e); records = []; }
}

/* ═══════════════════════════════════════════════════════
   APP ENTRY
═══════════════════════════════════════════════════════ */
async function enterApp() {
  showView('app');
  setNavLoggedIn();
  initRecognition();
  initTwilioDevice();
  const h = new Date().getHours();
  const name = userProfile?.full_name || currentUser?.user_metadata?.full_name || currentUser?.email?.split('@')[0] || 'there';
  document.getElementById('dash-greeting').textContent = (h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening') + ', ' + name.split(' ')[0];
  document.getElementById('dash-date').textContent = new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
  document.getElementById('set-name').textContent = userProfile?.full_name || name;
  document.getElementById('set-email').textContent = currentUser.email;
  document.getElementById('set-plan').textContent = PLAN_LABELS[userProfile?.plan] || PLAN_LABELS.free;
  const callerIdEl = document.getElementById('dialer-caller-id');
  const warningEl = document.getElementById('dialer-setup-warning');
  if (userProfile?.twilio_phone_number) {
    if (callerIdEl) callerIdEl.textContent = 'Calling from: ' + userProfile.twilio_phone_number;
    if (warningEl) warningEl.style.display = 'none';
  } else {
    if (callerIdEl) callerIdEl.textContent = '';
    if (warningEl) warningEl.style.display = 'block';
  }
  await loadRecords();
  refreshDashboard();
  updatePlanBadge();
}

function setNavLoggedIn() {
  const name = userProfile?.full_name || currentUser?.user_metadata?.full_name || currentUser?.email?.split('@')[0] || '';
  const plan = userProfile?.plan || 'free';
  const upgradeBtn = (plan === 'pro' || plan === 'team') ? '' : `<button class="btn btn-ghost" onclick="showUpgradeModal()">Upgrade</button>`;
  document.getElementById('nav-right').innerHTML = `<span style="font-size:13px;color:var(--text2)">${name}</span>${upgradeBtn}`;
}

/* ═══════════════════════════════════════════════════════
   PANELS
═══════════════════════════════════════════════════════ */
function showView(v) {
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
  document.getElementById('view-' + v).classList.add('active');
}

function switchPanel(p) {
  ['dashboard','analytics','recorder','log','settings','contacts','followups'].forEach(id => document.getElementById('panel-' + id).classList.add('hidden'));
  document.getElementById('panel-' + p).classList.remove('hidden');
  document.querySelectorAll('.sidebar-item').forEach(el => el.classList.remove('active'));
  document.getElementById('nav-' + p)?.classList.add('active');
  if (p === 'dashboard') refreshDashboard();
  if (p === 'analytics') renderAnalytics();
  if (p === 'log') renderLog();
  if (p === 'contacts') loadContacts();
  if (p === 'followups') loadFollowUps();
}

/* ═══════════════════════════════════════════════════════
   RECORDING
═══════════════════════════════════════════════════════ */
function initRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  recognition = new SR();
  recognition.continuous = true; recognition.interimResults = true; recognition.lang = 'en-US';
  let final = '';
  recognition.onresult = e => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) final += e.results[i][0].transcript + ' ';
      else interim += e.results[i][0].transcript;
    }
    fullTranscript = final;
    const el = document.getElementById('live-tx');
    if (el) el.textContent = (final + interim) || 'Listening...';
  };
  recognition.onerror = e => console.log('SR error:', e.error);
  recognition.onend = () => { if (isRecording) try { recognition.start(); } catch(e) {} };
}

function toggleRec() {
  if (!isRecording) startRec(); else stopRec();
}

function startRec() {
  const plan = userProfile?.plan || 'free';
  const limit = getCallLimit(plan);
  const used = userProfile?.calls_this_month || 0;
  if (!hasUnlimitedCalls(plan) && used >= limit) { showUpgradeModal(); return; }
  fullTranscript = '';
  navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    isRecording = true; seconds = 0;
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.start();
    if (recognition) try { recognition.start(); } catch(e) {}
    const btn = document.getElementById('rec-btn');
    btn.className = 'rec-btn recording';
    document.getElementById('rec-icon').innerHTML = '<rect x="6" y="6" width="4" height="12" rx="1" fill="#fff"/><rect x="14" y="6" width="4" height="12" rx="1" fill="#fff"/>';
    document.getElementById('rec-status').textContent = 'Recording...';
    document.getElementById('rec-sub').textContent = 'Stop when your call ends.';
    document.getElementById('rec-timer').style.display = 'block';
    document.getElementById('rec-wave').style.display = 'flex';
    document.getElementById('live-tx-wrap').classList.remove('hidden');
    timerInterval = setInterval(() => {
      seconds++;
      const m = Math.floor(seconds / 60), s = seconds % 60;
      const el = document.getElementById('rec-timer');
      if (el) el.textContent = m + ':' + (s < 10 ? '0' : '') + s;
    }, 1000);
  }).catch(() => alert('Microphone access denied. Please allow mic access in your browser settings.'));
}

function stopRec() {
  isRecording = false;
  clearInterval(timerInterval);
  if (recognition) try { recognition.stop(); } catch(e) {}
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    mediaRecorder.stream.getTracks().forEach(t => t.stop());
  }
  document.getElementById('rec-btn').className = 'rec-btn processing';
  document.getElementById('rec-status').textContent = 'Processing...';
  document.getElementById('rec-sub').textContent = 'AI is analyzing your call.';
  document.getElementById('rec-wave').style.display = 'none';
  setTimeout(() => processCall(), 700);
}

async function processCall() {
  switchRecTab('review');
  const transcript = fullTranscript.trim() || '[No speech detected - microphone may not have picked up audio clearly. Please fill in prospect details manually below.]';
  document.getElementById('final-tx').textContent = transcript;
  document.getElementById('ai-summary').textContent = 'Analyzing...';
  document.getElementById('ai-thinking').classList.remove('hidden');
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514', max_tokens: 1000,
        messages: [{ role: 'user', content: `You are a sales assistant for a mortgage/loan officer. Analyze this cold call transcript and return ONLY valid JSON with these keys:
"summary": 2-3 sentence plain-English summary,
"name": prospect full name or "",
"company": company/employer or "",
"phone": phone number or "",
"email": email or "",
"address": property address or "",
"outcome": one of exactly: Interested, Not interested, Callback, Voicemail, No answer,
"followUpDate": YYYY-MM-DD or "",
"painPoints": 1-2 sentences on prospect concerns,
"nextSteps": 1-2 sentences on agreed next actions.
Return ONLY JSON. No markdown, no preamble.
Transcript:\n${transcript}` }]
      })
    });
    const data = await resp.json();
    let text = data.content.map(b => b.text || '').join('').trim().replace(/```json|```/g, '').trim();
    const p = JSON.parse(text);
    document.getElementById('ai-thinking').classList.add('hidden');
    document.getElementById('ai-summary').textContent = p.summary || '-';
    const map = { name:'f-name', company:'f-company', phone:'f-phone', email:'f-email', address:'f-address', outcome:'f-outcome', followUpDate:'f-followup', painPoints:'f-pain', nextSteps:'f-nextsteps' };
    Object.entries(map).forEach(([k, id]) => { const el = document.getElementById(id); if (el && p[k]) el.value = p[k]; });
  } catch(e) {
    document.getElementById('ai-thinking').classList.add('hidden');
    document.getElementById('ai-summary').textContent = 'Could not generate summary - please fill in details manually.';
  }
}

function switchRecTab(tab) {
  document.getElementById('rec-panel').classList.toggle('hidden', tab !== 'record');
  document.getElementById('review-panel').classList.toggle('hidden', tab !== 'review');
  document.getElementById('tab-record').classList.toggle('active', tab === 'record');
  document.getElementById('tab-review').classList.toggle('active', tab === 'review');
}

/* ═══════════════════════════════════════════════════════
   SAVE RECORD TO SUPABASE
═══════════════════════════════════════════════════════ */
async function saveRecord() {
  const name = document.getElementById('f-name').value.trim();
  if (!name) { alert('Please enter the prospect name.'); return; }
  const btn = document.getElementById('save-btn');
  btn.disabled = true; btn.innerHTML = '<div class="spinner"></div> Saving...';
  const followUpRaw = document.getElementById('f-followup').value;
  const rec = {
    user_id: currentUser.id,
    call_date: new Date().toLocaleDateString('en-US'),
    prospect_name: name,
    company: document.getElementById('f-company').value.trim(),
    phone: document.getElementById('f-phone').value.trim(),
    email: document.getElementById('f-email').value.trim(),
    address: document.getElementById('f-address').value.trim(),
    outcome: document.getElementById('f-outcome').value,
    follow_up_date: followUpRaw || null,
    heat_score: (document.getElementById('heat-badge-display')?.dataset?.heatScore) || '',
    pain_points: document.getElementById('f-pain').value.trim(),
    next_steps: document.getElementById('f-nextsteps').value.trim(),
    transcript: document.getElementById('final-tx').textContent,
    ai_summary: document.getElementById('ai-summary').textContent,
    duration_seconds: seconds
  };
  try {
    if (SUPABASE_URL !== 'YOUR_SUPABASE_PROJECT_URL') {
      const { data, error } = await db.from('calls').insert([rec]).select().single();
      if (error) throw error;
      records.unshift(data);
      await db.from('profiles').update({ calls_this_month: (userProfile?.calls_this_month || 0) + 1 }).eq('id', currentUser.id);
      if (userProfile) userProfile.calls_this_month = (userProfile.calls_this_month || 0) + 1;
    } else {
      rec.id = Date.now(); rec.created_at = new Date().toISOString();
      records.unshift(rec);
    }
    document.getElementById('save-msg').classList.remove('hidden');
    setTimeout(() => document.getElementById('save-msg').classList.add('hidden'), 2500);
    resetRecorder();
    updatePlanBadge();
    refreshDashboard();
    const plan = userProfile?.plan || 'free';
    const limit = getCallLimit(plan);
    const used = userProfile?.calls_this_month || records.length;
    document.getElementById('set-calls').textContent = hasUnlimitedCalls(plan) ? used + ' (unlimited)' : used + ' / ' + limit;
  } catch(e) {
    alert('Error saving record: ' + e.message);
  }
  btn.disabled = false; btn.textContent = 'Save to log';
}

function resetRecorder() {
  ['f-name','f-company','f-phone','f-email','f-address','f-outcome','f-followup','f-pain','f-nextsteps'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.getElementById('final-tx').textContent = 'Transcript will appear here after recording.';
  document.getElementById('ai-summary').textContent = 'Summary will appear here.';
  document.getElementById('live-tx-wrap').classList.add('hidden');
  const btn = document.getElementById('rec-btn');
  if (btn) { btn.className = 'rec-btn idle'; document.getElementById('rec-icon').innerHTML = '<path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8"/>'; }
  document.getElementById('rec-status').textContent = 'Ready to record';
  document.getElementById('rec-sub').textContent = 'Tap the mic to begin';
  document.getElementById('rec-timer').style.display = 'none';
  document.getElementById('rec-timer').textContent = '0:00';
  fullTranscript = ''; seconds = 0;
  switchRecTab('record');
}

/* ═══════════════════════════════════════════════════════
   DELETE RECORD
═══════════════════════════════════════════════════════ */
async function deleteRecord(id) {
  if (!confirm('Delete this call record?')) return;
  try {
    if (SUPABASE_URL !== 'YOUR_SUPABASE_PROJECT_URL') {
      await db.from('calls').delete().eq('id', id).eq('user_id', currentUser.id);
    }
    records = records.filter(r => r.id !== id);
    refreshDashboard(); renderLog();
  } catch(e) { alert('Error deleting: ' + e.message); }
}

async function clearAllRecords() {
  if (!confirm('Delete ALL call records? This cannot be undone.')) return;
  try {
    if (SUPABASE_URL !== 'YOUR_SUPABASE_PROJECT_URL') {
      await db.from('calls').delete().eq('user_id', currentUser.id);
    }
    records = [];
    refreshDashboard(); renderLog();
  } catch(e) { alert('Error: ' + e.message); }
}

/* ═══════════════════════════════════════════════════════
   TABLE RENDERING
═══════════════════════════════════════════════════════ */
function badge(o) {
  const m = { Interested:'b-green', 'Not interested':'b-red', Callback:'b-amber', Voicemail:'b-blue', 'No answer':'b-gray' };
  return o ? `<span class="badge ${m[o]||'b-gray'}">${o}</span>` : '-';
}

function buildTable(recs) {
  if (!recs.length) return `<div class="empty-state"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="margin:0 auto 12px;display:block;color:var(--text3)"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.77 9.11 19.79 19.79 0 01.7 6.48A2 2 0 012.68 4h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.91 11.1a16 16 0 006 6l1.06-1.06a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>No calls logged yet. Hit "New call" to get started.</div>`;
  return `<div class="table-wrap"><table>
    <thead><tr><th>Name</th><th>Company</th><th>Date</th><th>Outcome</th><th>Follow-up</th><th>Pain points</th><th>Next steps</th><th></th></tr></thead>
    <tbody>${recs.map(r => `<tr>
      <td title="${r.prospect_name||''}"><strong>${r.prospect_name||'-'}</strong></td>
      <td>${r.company||'-'}</td>
      <td style="white-space:nowrap">${r.call_date||new Date(r.created_at).toLocaleDateString('en-US')}</td>
      <td>${badge(r.outcome)}</td>
      <td>${r.follow_up_date||'-'}</td>
      <td title="${r.pain_points||''}">${r.pain_points||'-'}</td>
      <td title="${r.next_steps||''}">${r.next_steps||'-'}</td>
      <td><button class="btn btn-danger" style="font-size:12px;padding:4px 10px" onclick="deleteRecord(${r.id})">Delete</button></td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

function refreshDashboard() {
  document.getElementById('st-total').textContent = records.length;
  document.getElementById('st-int').textContent = records.filter(r => r.outcome === 'Interested').length;
  document.getElementById('st-cb').textContent = records.filter(r => r.outcome === 'Callback').length;
  document.getElementById('dash-table').innerHTML = buildTable(records.slice(0, 8));
  // Load overdue follow-ups count from API
  db.auth.getSession().then(({ data: { session } }) => {
    if (!session) return;
    fetch('/api/follow-ups?status=pending&limit=100', { headers: { Authorization: 'Bearer ' + session.access_token } })
      .then(r => r.json()).then(items => {
        const now = new Date();
        const overdue = (items || []).filter(f => new Date(f.scheduled_at) <= now).length;
        document.getElementById('st-fu').textContent = overdue;
      }).catch(() => document.getElementById('st-fu').textContent = '—');
  });
}

function renderLog() {
  document.getElementById('log-table').innerHTML = buildTable(records);
}

function updatePlanBadge() {
  const plan = userProfile?.plan || 'free';
  const used = userProfile?.calls_this_month || records.length;
  const limit = getCallLimit(plan);
  const names = { free: 'Free plan', starter: 'Starter plan', pro: 'Pro plan', team: 'Team plan' };
  document.getElementById('plan-name').textContent = names[plan] || 'Free plan';
  document.getElementById('plan-usage').textContent = hasUnlimitedCalls(plan) ? 'Unlimited calls' : `${used} / ${limit} calls used`;

  const warn = document.getElementById('usage-warning');
  if (warn) {
    if (!hasUnlimitedCalls(plan) && used >= limit - 5 && used < limit) {
      warn.textContent = `⚠️ ${limit - used} analyzed call${limit - used === 1 ? '' : 's'} left this month`;
      warn.classList.remove('hidden');
    } else if (!hasUnlimitedCalls(plan) && used >= limit) {
      warn.textContent = 'Monthly limit reached — upgrade to keep analyzing calls';
      warn.classList.remove('hidden');
    } else {
      warn.classList.add('hidden');
    }
  }

  const upgradeBtn = document.querySelector('#sidebar-plan .btn-primary');
  if (upgradeBtn) upgradeBtn.style.display = (plan === 'pro' || plan === 'team') ? 'none' : '';
}

/* ═══════════════════════════════════════════════════════
   EXPORT
═══════════════════════════════════════════════════════ */
function toRows(recs) {
  return recs.map(r => ({
    'Date': r.call_date || new Date(r.created_at).toLocaleDateString('en-US'),
    'Name': r.prospect_name, 'Company': r.company,
    'Phone': r.phone, 'Email': r.email,
    'Property Address': r.address, 'Outcome': r.outcome,
    'Follow-up Date': r.follow_up_date, 'Pain Points': r.pain_points,
    'Next Steps': r.next_steps, 'AI Summary': r.ai_summary,
    'Transcript': r.transcript
  }));
}
function exportAll() {
  if (!records.length) { alert('No records to export yet.'); return; }
  const ws = XLSX.utils.json_to_sheet(toRows(records));
  ws['!cols'] = [10,20,20,14,22,22,14,12,32,32,32,50].map(w => ({ wch: w }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'PitchLog');
  XLSX.writeFile(wb, 'call_buddy_' + new Date().toISOString().slice(0, 10) + '.xlsx');
}
function exportOne() {
  const rec = [{
    'Date': new Date().toLocaleDateString('en-US'),
    'Name': document.getElementById('f-name')?.value || '',
    'Company': document.getElementById('f-company')?.value || '',
    'Phone': document.getElementById('f-phone')?.value || '',
    'Email': document.getElementById('f-email')?.value || '',
    'Property Address': document.getElementById('f-address')?.value || '',
    'Outcome': document.getElementById('f-outcome')?.value || '',
    'Follow-up Date': document.getElementById('f-followup')?.value || '',
    'Pain Points': document.getElementById('f-pain')?.value || '',
    'Next Steps': document.getElementById('f-nextsteps')?.value || '',
    'AI Summary': document.getElementById('ai-summary')?.textContent || '',
    'Transcript': document.getElementById('final-tx')?.textContent || ''
  }];
  const ws = XLSX.utils.json_to_sheet(rec);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Call');
  XLSX.writeFile(wb, 'call_' + (document.getElementById('f-name')?.value || 'prospect').replace(/\s+/g, '_') + '.xlsx');
}

/* ═══════════════════════════════════════════════════════
   STRIPE
═══════════════════════════════════════════════════════ */
function isPlaceholderStripePrice(id) {
  return !id || /STARTER|TEAM|_ANNUAL/.test(id);
}

async function handleStripe(tier, interval) {
  const planTier = tier || selectedUpgradeTier || 'pro';
  const billing = interval || selectedBillingInterval || 'monthly';
  const priceId = STRIPE_PRICES[planTier]?.[billing];
  if (isPlaceholderStripePrice(priceId)) {
    alert('Create Stripe prices for PitchLog ' + planTier + ' (' + billing + ') in your Stripe dashboard, then update STRIPE_PRICES in js/config.js.');
    return;
  }
  const finalPrice = priceId;
  try {
    const stripe = Stripe(STRIPE_KEY);
    await stripe.redirectToCheckout({
      lineItems: [{ price: finalPrice, quantity: 1 }],
      mode: 'subscription',
      clientReferenceId: currentUser?.id,
      customerEmail: currentUser?.email,
      successUrl: SITE_URL + '/app?upgraded=true&tier=' + planTier,
      cancelUrl: SITE_URL + '/pricing'
    });
  } catch(e) { alert('Stripe error: ' + e.message); }
}

function selectUpgradeTier(tier) {
  selectedUpgradeTier = tier;
  document.querySelectorAll('.upgrade-tier').forEach(el => el.classList.toggle('featured', el.dataset.tier === tier));
}

function setBillingInterval(interval) {
  selectedBillingInterval = interval;
  document.getElementById('bill-monthly')?.classList.toggle('active', interval === 'monthly');
  document.getElementById('bill-annual')?.classList.toggle('active', interval === 'annual');
}

function showUpgradeModal(tier) {
  if (tier) selectUpgradeTier(tier);
  document.getElementById('upgrade-modal').classList.remove('hidden');
}

/* ═══════════════════════════════════════════════════════
   MODAL HELPERS
═══════════════════════════════════════════════════════ */
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }
function bgClose(e, id) { if (e.target.id === id) closeModal(id); }
function showAlert(id, msg) { const el = document.getElementById(id); el.textContent = msg; el.classList.remove('hidden'); }

/* Handle Stripe success redirect */
if (window.location.search.includes('upgraded=true')) {
  const tier = new URLSearchParams(window.location.search).get('tier') || 'pro';
  setTimeout(() => {
    if (userProfile) { userProfile.plan = tier; updatePlanBadge(); }
    const msg = tier === 'starter' ? 'Starter' : tier === 'team' ? 'Team' : 'Pro';
    alert('🎉 Welcome to PitchLog ' + msg + '! Your plan is now active.');
    window.history.replaceState({}, '', '/app');
  }, 1000);
}

function toggleMobileMenu(){
  const m=document.getElementById("nav-links-menu");
  const b=document.getElementById("mobile-menu-btn");
  const isOpen=m.classList.contains("mobile-open");
  if(!isOpen){
    m.classList.add("mobile-open");
    m.style.cssText="display:flex!important;flex-direction:column;position:fixed;top:57px;left:0;right:0;background:var(--bg);border-bottom:1px solid var(--border);padding:20px 24px;gap:18px;z-index:999;box-shadow:0 8px 24px rgba(0,0,0,.12)";
    b.innerHTML='<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  } else {
    m.classList.remove("mobile-open");
    m.removeAttribute("style");
    b.innerHTML='<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>';
  }
}


/* ── AUDIO UPLOAD ── */
async function handleAudioUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  const label = document.getElementById('upload-label');
  const status = document.getElementById('upload-status');
  
  // Check file size (max 25MB)
  if (file.size > 25 * 1024 * 1024) {
    status.textContent = 'File too large. Max 25MB.';
    status.style.color = 'var(--danger)';
    return;
  }
  
  label.style.borderColor = 'var(--brand)';
  label.style.color = 'var(--brand)';
  status.textContent = 'Uploading and transcribing... this may take 30-60 seconds.';
  status.style.color = 'var(--text2)';
  
  try {
    // Convert audio to base64
    const reader = new FileReader();
    reader.onload = async (e) => {
      const base64 = e.target.result.split(',')[1];
      const mimeType = file.type || 'audio/mp3';
      const { data: { session } } = await db.auth.getSession();
      const authHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` };

      // Send to Anthropic for transcription via server
      const resp = await fetch('/api/analyze', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          type: 'audio',
          audioData: base64,
          mimeType: mimeType,
          fileName: file.name
        })
      });

      const result = await resp.json();
      if (!resp.ok) throw new Error(result.error || 'Transcription failed');

      // Set transcript and switch to review tab
      fullTranscript = result.transcript || '';
      document.getElementById('final-tx').textContent = fullTranscript;

      // Auto-run AI analysis
      status.textContent = 'Transcribed! Running AI analysis...';
      switchRecTab('review');
      document.getElementById('ai-thinking').classList.remove('hidden');

      // Now analyze the transcript
      const analyzeResp = await fetch('/api/analyze', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ transcript: fullTranscript, type: 'analyze' })
      });
      const p = await analyzeResp.json();
      
      document.getElementById('ai-thinking').classList.add('hidden');
      document.getElementById('ai-summary').textContent = p.summary || 'Analysis complete.';
      
      const map = {name:'f-name',company:'f-company',phone:'f-phone',email:'f-email',address:'f-address',outcome:'f-outcome',followUpDate:'f-followup',painPoints:'f-pain',nextSteps:'f-nextsteps'};
      Object.entries(map).forEach(([k,id]) => { const el=document.getElementById(id); if(el&&p[k]) el.value=p[k]; });
      
      if (p.heatScore) {
        const badge = document.getElementById('heat-badge-display');
        const cls = {Hot:'heat-hot',Warm:'heat-warm',Cold:'heat-cold'};
        const icons = {Hot:'&#128293;',Warm:'&#9728;',Cold:'&#10052;'};
        badge.innerHTML = `<span class="heat-badge ${cls[p.heatScore]||'heat-neutral'}">${icons[p.heatScore]||''} ${p.heatScore}</span>`;
      }
      
      status.textContent = 'Done! Review the fields below and save.';
      status.style.color = 'var(--brand)';
    };
    reader.readAsDataURL(file);
  } catch(err) {
    status.textContent = 'Error: ' + err.message;
    status.style.color = 'var(--danger)';
    label.style.borderColor = 'var(--border)';
    label.style.color = 'var(--text2)';
  }
}

// ── Forgot-password flow ───────────────────────────────────────────────────
async function handleForgotPassword() {
  if (SUPABASE_URL === 'YOUR_SUPABASE_PROJECT_URL') {
    showAlert('auth-alert', '⚠️ Supabase is not configured yet. Open index.html and add your SUPABASE_URL and SUPABASE_ANON_KEY. See README for instructions.');
    return;
  }
  const email = document.getElementById('a-email').value.trim();
  document.getElementById('auth-alert').classList.add('hidden');
  if (!email) { showAlert('auth-alert', 'Enter your email above, then click “Forgot password?”'); return; }
  try {
    const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo: SITE_URL + '/app' });
    if (error) throw error;
    showAlert('auth-alert', '✓ If an account exists for that email, a password reset link is on its way.');
  } catch(e) {
    showAlert('auth-alert', e.message || 'Could not send reset email. Please try again.');
  }
}

// Separate listener for password-recovery deep links (kept apart from the main onAuthStateChange).
db.auth.onAuthStateChange((event) => {
  if (event === 'PASSWORD_RECOVERY') {
    const next = window.prompt('Enter a new password (min. 6 characters):');
    if (!next) return;
    if (next.length < 6) { alert('Password must be at least 6 characters.'); return; }
    db.auth.updateUser({ password: next })
      .then(({ error }) => alert(error ? (error.message || 'Could not update password.') : '✓ Password updated. You are now signed in.'));
  }
});

/* ═══════════════════════════════════════════════════════
   CONTACTS CRM
═══════════════════════════════════════════════════════ */
let contactsCache = [];
const STAGE_LABELS = { new:'New lead', contacted:'Contacted', qualified:'Qualified', appointment:'Appointment set', closed:'Closed' };
const STAGE_COLORS = { new:'#6b7280', contacted:'#3b82f6', qualified:'#f59e0b', appointment:'#8b5cf6', closed:'#10b981' };

async function loadContacts() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) return;
  const search = document.getElementById('contact-search')?.value || '';
  const stage = document.getElementById('contact-stage-filter')?.value || '';
  let url = '/api/contacts';
  const params = [];
  if (search) params.push('search=' + encodeURIComponent(search));
  if (stage) params.push('stage=' + encodeURIComponent(stage));
  if (params.length) url += '?' + params.join('&');
  try {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + session.access_token } });
    contactsCache = await r.json();
    renderContacts();
  } catch (e) {
    document.getElementById('contacts-table').innerHTML = '<p style="color:var(--danger);padding:20px">Failed to load contacts.</p>';
  }
}

function renderContacts() {
  const search = (document.getElementById('contact-search')?.value || '').toLowerCase();
  const stage = document.getElementById('contact-stage-filter')?.value || '';
  let rows = contactsCache;
  if (search) rows = rows.filter(c => (c.name||'').toLowerCase().includes(search) || (c.company||'').toLowerCase().includes(search) || (c.phone||'').includes(search));
  if (stage) rows = rows.filter(c => c.stage === stage);

  if (!rows.length) {
    document.getElementById('contacts-table').innerHTML = '<p style="color:var(--text3);padding:20px;text-align:center">No contacts found.</p>';
    return;
  }
  const html = `<div class="table-card" style="overflow:auto">
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <thead><tr style="border-bottom:2px solid var(--border)">
        <th style="text-align:left;padding:10px 14px;color:var(--text2);font-weight:500">Name</th>
        <th style="text-align:left;padding:10px 14px;color:var(--text2);font-weight:500">Phone</th>
        <th style="text-align:left;padding:10px 14px;color:var(--text2);font-weight:500">Company</th>
        <th style="text-align:left;padding:10px 14px;color:var(--text2);font-weight:500">Stage</th>
        <th style="text-align:left;padding:10px 14px;color:var(--text2);font-weight:500">Heat</th>
        <th style="text-align:left;padding:10px 14px;color:var(--text2);font-weight:500">Calls</th>
        <th style="text-align:left;padding:10px 14px;color:var(--text2);font-weight:500">Next follow-up</th>
        <th style="padding:10px 14px"></th>
      </tr></thead>
      <tbody>${rows.map(c => {
        const heat = c.heat_score || 'Cold';
        const hc = heat === 'Hot' ? '#dc2626' : heat === 'Warm' ? '#f59e0b' : '#6b7280';
        const nfu = c.next_follow_up_at ? new Date(c.next_follow_up_at).toLocaleDateString() : '—';
        const stage = c.stage || 'new';
        return `<tr style="border-bottom:1px solid var(--border)" onmouseover="this.style.background='var(--bg2)'" onmouseout="this.style.background=''">
          <td style="padding:10px 14px;font-weight:500">${esc(c.name||'Unknown')}</td>
          <td style="padding:10px 14px;color:var(--text2)">${esc(c.phone||'—')}</td>
          <td style="padding:10px 14px;color:var(--text2)">${esc(c.company||'—')}</td>
          <td style="padding:10px 14px"><span style="background:${STAGE_COLORS[stage]}22;color:${STAGE_COLORS[stage]};font-size:12px;font-weight:600;padding:3px 10px;border-radius:99px">${STAGE_LABELS[stage]||stage}</span></td>
          <td style="padding:10px 14px"><span style="color:${hc};font-weight:600;font-size:13px">${heat}</span></td>
          <td style="padding:10px 14px;color:var(--text2)">${c.call_count||0}</td>
          <td style="padding:10px 14px;color:var(--text2);font-size:13px">${nfu}</td>
          <td style="padding:10px 14px">
            <button class="btn btn-ghost" style="font-size:12px;padding:5px 10px" onclick="openContactFollowUp('${c.id}','${esc(c.name||'Unknown')}')">Follow-up</button>
            <button class="btn btn-ghost" style="font-size:12px;padding:5px 10px" onclick="deleteContact('${c.id}')">Delete</button>
          </td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
  document.getElementById('contacts-table').innerHTML = html;
}

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function openAddContactModal() {
  document.getElementById('ac-name').value = '';
  document.getElementById('ac-phone').value = '';
  document.getElementById('ac-company').value = '';
  document.getElementById('ac-email').value = '';
  document.getElementById('ac-stage').value = 'new';
  document.getElementById('ac-notes').value = '';
  document.getElementById('add-contact-alert').classList.add('hidden');
  document.getElementById('add-contact-modal').classList.remove('hidden');
}

async function saveNewContact() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) return;
  const body = {
    name: document.getElementById('ac-name').value.trim() || 'Unknown',
    phone: document.getElementById('ac-phone').value.trim(),
    company: document.getElementById('ac-company').value.trim(),
    email: document.getElementById('ac-email').value.trim(),
    stage: document.getElementById('ac-stage').value,
    notes: document.getElementById('ac-notes').value.trim()
  };
  if (!body.phone) {
    const el = document.getElementById('add-contact-alert');
    el.textContent = 'Phone number is required.'; el.classList.remove('hidden'); return;
  }
  try {
    const r = await fetch('/api/contacts', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token }, body: JSON.stringify(body) });
    if (!r.ok) { const d = await r.json(); throw new Error(d.error || 'Save failed'); }
    closeModal('add-contact-modal');
    loadContacts();
  } catch (e) {
    const el = document.getElementById('add-contact-alert');
    el.textContent = e.message; el.classList.remove('hidden');
  }
}

async function deleteContact(id) {
  if (!confirm('Delete this contact? This cannot be undone.')) return;
  const { data: { session } } = await db.auth.getSession();
  if (!session) return;
  await fetch('/api/contacts?id=' + id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + session.access_token } });
  loadContacts();
}

/* ═══════════════════════════════════════════════════════
   FOLLOW-UPS
═══════════════════════════════════════════════════════ */
let followUpsCache = [];
let fuFilter = 'pending';

function setFuFilter(f) {
  fuFilter = f;
  ['pending','sent','all'].forEach(x => {
    const btn = document.getElementById('fu-filter-' + x);
    if (btn) { btn.className = x === f ? 'btn btn-outline' : 'btn btn-ghost'; btn.style.fontSize = '13px'; }
  });
  loadFollowUps();
}

async function loadFollowUps() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) return;
  try {
    const r = await fetch('/api/follow-ups?status=' + fuFilter + '&limit=100', { headers: { Authorization: 'Bearer ' + session.access_token } });
    followUpsCache = await r.json();
    renderFollowUps();
    updateFollowUpsBadge();
  } catch (e) {
    document.getElementById('followups-list').innerHTML = '<p style="color:var(--danger);padding:20px">Failed to load follow-ups.</p>';
  }
}

async function updateFollowUpsBadge() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) return;
  try {
    const r = await fetch('/api/follow-ups?status=pending&limit=100', { headers: { Authorization: 'Bearer ' + session.access_token } });
    const items = await r.json();
    const now = new Date();
    const overdue = items.filter(f => new Date(f.scheduled_at) <= now).length;
    const badge = document.getElementById('followups-badge');
    if (badge) {
      if (overdue > 0) { badge.textContent = overdue; badge.style.display = 'inline-block'; }
      else badge.style.display = 'none';
    }
  } catch (e) {}
}

function renderFollowUps() {
  const list = followUpsCache;
  if (!list.length) {
    document.getElementById('followups-list').innerHTML = '<p style="color:var(--text3);padding:20px;text-align:center">No follow-ups found.</p>';
    return;
  }
  const now = new Date();
  const html = list.map(f => {
    const scheduled = new Date(f.scheduled_at);
    const overdue = f.status === 'pending' && scheduled < now;
    const sent = f.status === 'sent';
    const contact = f.contacts;
    return `<div style="background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);padding:16px 20px;margin-bottom:10px;display:flex;gap:14px;align-items:flex-start">
      <div style="flex:1">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap">
          <strong>${esc(contact?.name||'Unknown')}</strong>
          <span style="font-size:12px;color:var(--text3)">${esc(contact?.phone||'')}</span>
          <span style="font-size:11px;background:${f.type==='sms'?'#dbeafe':'#f3f4f6'};color:${f.type==='sms'?'#1d4ed8':'#6b7280'};padding:2px 8px;border-radius:99px;font-weight:600">${f.type?.toUpperCase()||'SMS'}</span>
          ${overdue ? '<span style="font-size:11px;background:#fee2e2;color:#dc2626;padding:2px 8px;border-radius:99px;font-weight:600">OVERDUE</span>' : ''}
          ${sent ? '<span style="font-size:11px;background:#d1fae5;color:#059669;padding:2px 8px;border-radius:99px;font-weight:600">SENT</span>' : ''}
        </div>
        <div style="font-size:13px;color:var(--text2);margin-bottom:6px">${esc(f.message||'')}</div>
        <div style="font-size:12px;color:var(--text3)">Scheduled: ${scheduled.toLocaleString()}${sent && f.sent_at ? ' · Sent: ' + new Date(f.sent_at).toLocaleString() : ''}</div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        ${!sent ? `<button class="btn btn-primary" style="font-size:12px;padding:6px 12px" onclick="sendFollowUpNow('${f.id}')">Send now</button>` : ''}
        <button class="btn btn-ghost" style="font-size:12px;padding:6px 10px" onclick="deleteFollowUp('${f.id}')">✕</button>
      </div>
    </div>`;
  }).join('');
  document.getElementById('followups-list').innerHTML = html;
}

async function sendFollowUpNow(id) {
  const { data: { session } } = await db.auth.getSession();
  if (!session) return;
  const btn = event.target;
  btn.disabled = true; btn.textContent = 'Sending...';
  try {
    const r = await fetch('/api/send-follow-up', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token },
      body: JSON.stringify({ follow_up_id: id })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Send failed');
    loadFollowUps();
  } catch (e) {
    alert('Failed to send: ' + e.message);
    btn.disabled = false; btn.textContent = 'Send now';
  }
}

async function deleteFollowUp(id) {
  const { data: { session } } = await db.auth.getSession();
  if (!session) return;
  await fetch('/api/follow-ups?id=' + id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + session.access_token } });
  loadFollowUps();
}

function openAddFollowUpModal() {
  const sel = document.getElementById('fu-contact-select');
  sel.innerHTML = '<option value="">Select contact...</option>' +
    contactsCache.map(c => `<option value="${c.id}">${esc(c.name||'Unknown')} — ${esc(c.phone||'')}</option>`).join('');
  if (!contactsCache.length) {
    // reload contacts in background
    db.auth.getSession().then(({ data: { session } }) => {
      if (!session) return;
      fetch('/api/contacts', { headers: { Authorization: 'Bearer ' + session.access_token } })
        .then(r => r.json()).then(data => {
          contactsCache = data;
          sel.innerHTML = '<option value="">Select contact...</option>' +
            contactsCache.map(c => `<option value="${c.id}">${esc(c.name||'Unknown')} — ${esc(c.phone||'')}</option>`).join('');
        });
    });
  }
  const now = new Date();
  now.setDate(now.getDate() + 1);
  now.setMinutes(0, 0, 0);
  document.getElementById('fu-scheduled-at').value = now.toISOString().slice(0, 16);
  document.getElementById('fu-message').value = '';
  document.getElementById('add-followup-alert').classList.add('hidden');
  document.getElementById('add-followup-modal').classList.remove('hidden');
}

function openContactFollowUp(contactId, contactName) {
  openAddFollowUpModal();
  setTimeout(() => {
    const sel = document.getElementById('fu-contact-select');
    sel.value = contactId;
    document.getElementById('fu-message').value = `Hi ${contactName}, just following up on our conversation. Let me know if you have any questions!`;
  }, 50);
}

async function saveNewFollowUp() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) return;
  const contact_id = document.getElementById('fu-contact-select').value;
  const type = document.getElementById('fu-type').value;
  const message = document.getElementById('fu-message').value.trim();
  const scheduled_at = document.getElementById('fu-scheduled-at').value;
  if (!contact_id || !scheduled_at) {
    const el = document.getElementById('add-followup-alert');
    el.textContent = 'Contact and schedule time are required.'; el.classList.remove('hidden'); return;
  }
  try {
    const r = await fetch('/api/follow-ups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token },
      body: JSON.stringify({ contact_id, type, message, scheduled_at: new Date(scheduled_at).toISOString() })
    });
    if (!r.ok) { const d = await r.json(); throw new Error(d.error || 'Save failed'); }
    closeModal('add-followup-modal');
    loadFollowUps();
  } catch (e) {
    const el = document.getElementById('add-followup-alert');
    el.textContent = e.message; el.classList.remove('hidden');
  }
}

// Poll for overdue badge on app load
setTimeout(updateFollowUpsBadge, 3000);
