/* DSCR Florida Lead Machine — front-end logic
 * - Live DSCR calculator (with RentCast rent estimate)
 * - UTM capture + DSCR hand-off into the lead form
 * - Lead form submit -> POST /api/lead
 * - Lightweight analytics event hooks (GA4 / Meta Pixel if present)
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  // ---- Analytics helper (no-ops if GA4 / Pixel aren't loaded yet) ----
  function track(event, params) {
    try { if (window.gtag) window.gtag('event', event, params || {}); } catch (e) {}
    try { if (window.fbq) window.fbq('trackCustom', event, params || {}); } catch (e) {}
  }
  // Meta standard event (optimizable in Ads Manager). eventID enables
  // client+server (CAPI) deduplication.
  function fbStd(name, params, eventID) {
    try { if (window.fbq) window.fbq('track', name, params || {}, eventID ? { eventID: eventID } : undefined); } catch (e) {}
  }
  function getCookie(n) {
    var m = document.cookie.match('(^|;)\\s*' + n + '\\s*=\\s*([^;]+)');
    return m ? m.pop() : '';
  }
  function newEventId() { return 'lead.' + Date.now() + '.' + Math.random().toString(36).slice(2, 10); }

  // CTA click tracking (delegated) + Meta "Contact" on any call button
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-cta]');
    if (!el) return;
    track('cta_click', { cta: el.getAttribute('data-cta') });
    if (el.classList.contains('js-call')) fbStd('Contact', { content_name: 'phone_call' });
  });

  // Footer year
  var yr = $('year'); if (yr) yr.textContent = new Date().getFullYear();

  // ---- Cinematic motion: scroll-reveal + header state ----
  var reveals = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && reveals.length) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add('in'); });
  }

  var header = document.querySelector('.site-header');
  if (header) {
    var onScroll = function () { header.classList.toggle('scrolled', window.scrollY > 40); };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  // ---- UTM capture ----
  var utm = {};
  try {
    var qs = new URLSearchParams(location.search);
    ['utm_source', 'utm_medium', 'utm_campaign'].forEach(function (k) {
      if (qs.get(k)) utm[k] = qs.get(k);
    });
  } catch (e) {}

  // =================== Calculator ===================
  var addr = $('calc-address');
  var rentIn = $('calc-rent');
  var loanIn = $('calc-loan');
  var rateIn = $('calc-rate');
  var expIn = $('calc-expenses');
  var dscrOut = $('calc-dscr');
  var verdict = $('calc-verdict');
  var pitiOut = $('calc-piti');
  var rentOut = $('calc-rent-out');
  var estBtn = $('calc-estimate-btn');
  var rentNote = $('calc-rent-note');

  var lastDscr = null;

  function money(n) {
    if (!isFinite(n) || n <= 0) return '—';
    return '$' + Math.round(n).toLocaleString('en-US');
  }

  // Monthly principal & interest for a 30-yr fixed.
  function monthlyPI(loan, ratePct) {
    if (!(loan > 0)) return 0;
    var r = (ratePct || 0) / 100 / 12;
    var n = 360;
    if (r === 0) return loan / n;
    return loan * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
  }

  function recalc() {
    var rent = parseFloat(rentIn.value) || 0;
    var loan = parseFloat(loanIn.value) || 0;
    var rate = parseFloat(rateIn.value) || 0;
    var exp = parseFloat(expIn.value) || 0;

    var pi = monthlyPI(loan, rate);
    var pitia = pi + exp; // P&I + taxes/insurance/HOA = full debt service
    pitiOut.textContent = money(pitia);
    rentOut.textContent = money(rent);

    if (rent > 0 && pitia > 0) {
      var dscr = rent / pitia;
      lastDscr = Math.round(dscr * 100) / 100;
      dscrOut.textContent = lastDscr.toFixed(2);
      setVerdict(lastDscr);
    } else {
      lastDscr = null;
      dscrOut.textContent = '—';
      verdict.textContent = '';
      verdict.className = 'result-verdict';
    }
  }

  function setVerdict(d) {
    verdict.className = 'result-verdict';
    if (d >= 1.25) { verdict.textContent = 'Strong — likely best pricing'; verdict.classList.add('good'); }
    else if (d >= 1.0) { verdict.textContent = 'Qualifies — covers the payment'; verdict.classList.add('good'); }
    else if (d >= 0.75) { verdict.textContent = 'Low-ratio programs available'; verdict.classList.add('ok'); }
    else { verdict.textContent = "Let's find an option that fits"; verdict.classList.add('low'); }
  }

  [rentIn, loanIn, rateIn, expIn].forEach(function (el) {
    if (el) el.addEventListener('input', recalc);
  });

  // ---- RentCast estimate ----
  function estimateRent() {
    var value = (addr.value || '').trim();
    if (!value) { setNote('Enter an address first.', 'warn'); return; }
    setNote('Estimating market rent…', '');
    estBtn.disabled = true;

    fetch('/api/rent-estimate?address=' + encodeURIComponent(value))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.available && data.rent) {
          rentIn.value = data.rent;
          var range = (data.low && data.high) ? ' (range ' + money(data.low) + '–' + money(data.high) + ')' : '';
          setNote('Estimated rent: ' + money(data.rent) + range + '. Adjust if you know the actual rent.', 'ok');
          recalc();
          track('rent_estimate', { rent: data.rent });
        } else {
          setNote("Couldn't auto-estimate this address — type the monthly rent manually.", 'warn');
        }
      })
      .catch(function () {
        setNote('Estimate unavailable — type the monthly rent manually.', 'warn');
      })
      .finally(function () { estBtn.disabled = false; });
  }

  function setNote(msg, cls) {
    if (!rentNote) return;
    rentNote.textContent = msg;
    rentNote.className = 'hint' + (cls ? ' ' + cls : '');
  }

  if (estBtn) estBtn.addEventListener('click', estimateRent);
  if (addr) addr.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); estimateRent(); }
  });

  // ---- Calculator CTA hands values to the form ----
  var calcCta = $('calc-cta');
  if (calcCta) calcCta.addEventListener('click', function () {
    // Mid-funnel intent signal for ad optimization
    fbStd('ViewContent', { content_name: 'DSCR Qualifier', value: lastDscr || 0, currency: 'USD' });
    var form = $('lead-form');
    if (!form) return;
    if (addr && addr.value) form.elements['property_address'].value = addr.value;
    if (rentIn && rentIn.value) form.elements['estimated_rent'].value = rentIn.value;
    if (lastDscr != null) form.elements['dscr_ratio'].value = lastDscr;
  });

  recalc();

  // =================== Lead form ===================
  var form = $('lead-form');
  var statusEl = $('form-status');
  var submitBtn = $('lead-submit');

  if (form) {
    // Seed hidden UTM fields
    ['utm_source', 'utm_medium', 'utm_campaign'].forEach(function (k) {
      if (form.elements[k] && utm[k]) form.elements[k].value = utm[k];
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      setStatus('', '');

      var data = {};
      Array.prototype.forEach.call(form.elements, function (el) {
        if (el.name) data[el.name] = el.value.trim();
      });

      if (!data.name || !data.phone) {
        setStatus('Please add your name and phone so I can reach you.', 'err');
        return;
      }

      submitBtn.disabled = true;
      var original = submitBtn.textContent;
      submitBtn.textContent = 'Sending…';

      // Meta dedup: same event_id fires client-side (Pixel) and server-side (CAPI)
      var eventId = newEventId();
      data.event_id = eventId;
      data.fbp = getCookie('_fbp');
      data.fbc = getCookie('_fbc');
      data.event_source_url = location.href;

      // Fire the Pixel Lead now so it isn't lost if the user navigates away
      fbStd('Lead', { value: 1, currency: 'USD' }, eventId);
      track('lead', { value: 1, currency: 'USD' });

      fetch('/api/lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          if (!res.ok) throw new Error(res.j && res.j.error || 'Submission failed');
          setStatus("Got it! I'll reach out shortly — usually within 5 minutes during business hours.", 'ok');
          form.reset();
        })
        .catch(function (err) {
          setStatus('Something went wrong — please call me directly and I\'ll take care of you.', 'err');
          console.error(err);
        })
        .finally(function () {
          submitBtn.disabled = false;
          submitBtn.textContent = original;
        });
    });
  }

  function setStatus(msg, cls) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.className = 'form-status' + (cls ? ' ' + cls : '');
  }
})();
