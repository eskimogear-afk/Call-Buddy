/* =====================================================================
 * config.js — EDIT THIS ONE FILE TO LAUNCH.
 * Paste your real values below. Everything on the page (phone numbers,
 * footer NMLS/disclaimer, analytics, structured data) updates from here.
 * Leave a value as its placeholder and that piece simply stays a placeholder.
 * ===================================================================== */
window.DSCR_CONFIG = {
  // --- Contact (shown on every call button + click-to-call) ---
  phoneDisplay: '(555) 555-5555',     // what visitors see
  phoneE164:    '+15555555555',       // tel: link target, e.g. +14075551234

  // --- Compliance (from Visto — Phase 0) ---
  companyNmls:  '[COMPANY_NMLS]',     // Visto company NMLS #
  states:       '[STATES]',           // e.g. "Florida" or "FL, IL, IN, MI"

  // --- Site ---
  domain:       'https://YOUR-DOMAIN.com',

  // --- Analytics (paste an ID and it turns ON automatically) ---
  ga4:          '',                   // 'G-XXXXXXXXXX'  (Google Analytics 4)
  plausible:    '',                   // 'your-domain.com' (use instead of GA4)
  metaPixel:    '',                   // '123456789012345' (Meta/Facebook Pixel)
};

(function () {
  'use strict';
  var C = window.DSCR_CONFIG;
  var isReal = function (v) {
    return v && !/^\[|YOUR-DOMAIN|5555555|^$/.test(v) && v !== '(555) 555-5555';
  };

  // ---- Phone everywhere ----
  document.querySelectorAll('a.js-call').forEach(function (a) {
    a.setAttribute('href', 'tel:' + C.phoneE164);
  });
  document.querySelectorAll('.js-phone').forEach(function (el) {
    el.textContent = C.phoneDisplay;
  });

  // ---- Footer compliance ----
  var setText = function (sel, val) {
    document.querySelectorAll(sel).forEach(function (el) { el.textContent = val; });
  };
  if (isReal(C.companyNmls)) setText('.js-company-nmls', C.companyNmls);
  if (isReal(C.states)) setText('.js-states', C.states);

  // ---- Canonical + Open Graph (helps Google; note: social crawlers prefer
  // static head tags, so also set the domain in index.html before launch) ----
  if (isReal(C.domain)) {
    var base = C.domain.replace(/\/$/, '');
    var setAttr = function (sel, attr, val) {
      var el = document.querySelector(sel); if (el) el.setAttribute(attr, val);
    };
    setAttr('link[rel="canonical"]', 'href', base + '/');
    setAttr('meta[property="og:url"]', 'content', base + '/');
    setAttr('meta[property="og:image"]', 'content', base + '/assets/og-image.png');
  }

  // ---- Analytics: inject only when an ID is present ----
  var head = document.head;
  if (isReal(C.ga4)) {
    var g = document.createElement('script');
    g.async = true;
    g.src = 'https://www.googletagmanager.com/gtag/js?id=' + C.ga4;
    head.appendChild(g);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', C.ga4);
  } else if (isReal(C.plausible)) {
    var p = document.createElement('script');
    p.defer = true;
    p.setAttribute('data-domain', C.plausible);
    p.src = 'https://plausible.io/js/script.js';
    head.appendChild(p);
  }
  if (isReal(C.metaPixel)) {
    !function (f, b, e, v, n, t, s) {
      if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = [];
      t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    window.fbq('init', C.metaPixel);
    window.fbq('track', 'PageView');
  }

  // ---- Structured data (LocalBusiness/FinancialService) for local SEO ----
  var ld = {
    '@context': 'https://schema.org',
    '@type': 'FinancialService',
    name: 'Damon — DSCR Florida Investor Loans',
    description: 'DSCR investor loans across Florida — qualify on rental income, not tax returns.',
    url: isReal(C.domain) ? C.domain : undefined,
    telephone: isReal(C.phoneE164) ? C.phoneE164 : undefined,
    areaServed: ['Orlando', 'Kissimmee', 'Tampa', 'Jacksonville', 'Miami', 'Florida'],
    knowsAbout: ['DSCR loans', 'investment property financing', 'BRRRR', 'bank statement loans', 'fix and flip'],
    provider: { '@type': 'Person', name: 'Damon', jobTitle: 'Mortgage Loan Originator', identifier: 'NMLS #2291737' }
  };
  var s = document.createElement('script');
  s.type = 'application/ld+json';
  s.textContent = JSON.stringify(ld);
  head.appendChild(s);
})();
