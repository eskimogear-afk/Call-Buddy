#!/usr/bin/env node
/**
 * new-realtors.mjs — build a call sheet of newly licensed Florida real estate
 * agents from the DBPR public licensee download.
 *
 * WHY: newly licensed agents are building their business and need a lender
 * partner — high-value referral prospects for DSCR / investor loans.
 *
 * STEP 1 — get the data (manual, one click):
 *   FL DBPR Real Estate Commission public records:
 *     https://www2.myfloridalicense.com/real-estate-commission/public-records/
 *   Download the weekly Real Estate licensee CSV (name, license type, ORIGINAL
 *   LICENSE DATE, county, city, mailing address).
 *
 * STEP 2 — run this on the file:
 *   node new-realtors.mjs ./dbpr_real_estate.csv
 *   node new-realtors.mjs ./dbpr_real_estate.csv --days 45 \
 *        --counties "ORANGE,OSCEOLA,SEMINOLE,LAKE,POLK" --out orlando-new-agents.csv
 *
 * FLAGS:
 *   --days N         only agents licensed in the last N days     (default 60)
 *   --counties "A,B" target counties, comma-separated, UPPER     (default Central FL + Tampa/Jax/Miami)
 *   --brokers        also include brokers/broker-associates       (default: sales associates only)
 *   --out FILE       write the call sheet CSV                      (default: new-realtors-callsheet.csv)
 *
 * PHONES: the DBPR file has NO phone numbers. Each row gets a ready-made Google
 * lookup link ("<name>" realtor <city> phone) so enrichment is one click.
 *
 * COMPLIANCE (you're a licensed MLO — keep it clean):
 *   • Dial manually — no autodialer / prerecorded messages (TCPA).
 *   • Partner for referrals, never PAY for them (RESPA §8).
 */

import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const getFlag = (name, def) => {
  const i = args.indexOf('--' + name);
  if (i === -1) return def;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
if (!file) {
  console.error('Usage: node new-realtors.mjs <dbpr.csv> [--days 60] [--counties "ORANGE,OSCEOLA"] [--brokers] [--out file.csv]');
  process.exit(1);
}
const days = parseInt(getFlag('days', '60'), 10);
const includeBrokers = getFlag('brokers', false) === true;
const outFile = getFlag('out', 'new-realtors-callsheet.csv');
const counties = String(
  getFlag('counties', 'ORANGE,OSCEOLA,SEMINOLE,LAKE,POLK,HILLSBOROUGH,PINELLAS,DUVAL,MIAMI-DADE')
).toUpperCase().split(',').map((c) => c.trim()).filter(Boolean);

// tiny RFC-4180 CSV parser
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function findCol(headers, ...needles) {
  const H = headers.map((h) => h.toLowerCase().trim());
  for (const test of needles) {
    const idx = H.findIndex((h) => test.every((t) => h.includes(t)));
    if (idx !== -1) return idx;
  }
  return -1;
}

const raw = readFileSync(file, 'utf8');
const rows = parseCSV(raw).filter((r) => r.length > 1);
if (!rows.length) { console.error('Empty/unreadable CSV.'); process.exit(1); }

const headers = rows[0];
const col = {
  name:   findCol(headers, ['licensee', 'name'], ['name']),
  type:   findCol(headers, ['license', 'type'], ['rank'], ['type']),
  date:   findCol(headers, ['original', 'date'], ['licensure'], ['licens', 'date']),
  county: findCol(headers, ['county']),
  city:   findCol(headers, ['city']),
  addr1:  findCol(headers, ['address', '1'], ['mail', 'address'], ['address']),
  zip:    findCol(headers, ['zip']),
};
if (col.date === -1 || col.county === -1 || col.name === -1) {
  console.error('Could not locate Name / County / Original-License-Date columns.');
  console.error('Headers found:', headers.join(' | '));
  process.exit(1);
}

const parseDate = (s) => {
  if (!s) return null;
  const m = String(s).trim().match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m) return new Date(+m[3], +m[1] - 1, +m[2]);
  const d = new Date(s);
  return isNaN(d) ? null : d;
};
const cutoff = new Date(Date.now() - days * 86400000);

const pick = [];
for (let i = 1; i < rows.length; i++) {
  const r = rows[i];
  const type = (r[col.type] || '').toUpperCase();
  const isSales = type.includes('SALES ASSOCIATE') || /\bSL\b/.test(type);
  const isBroker = type.includes('BROKER');
  if (!(isSales || (includeBrokers && isBroker))) continue;

  const county = (r[col.county] || '').toUpperCase().trim();
  if (counties.length && !counties.includes(county)) continue;

  const d = parseDate(r[col.date]);
  if (!d || d < cutoff) continue;

  pick.push({
    name: r[col.name] || '',
    type: r[col.type] || '',
    licensed: d,
    county,
    city: col.city > -1 ? r[col.city] || '' : '',
    address: col.addr1 > -1 ? r[col.addr1] || '' : '',
    zip: col.zip > -1 ? r[col.zip] || '' : '',
  });
}
pick.sort((a, b) => b.licensed - a.licensed);

const fmt = (d) => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
const lookup = (p) =>
  'https://www.google.com/search?q=' +
  encodeURIComponent(`"${p.name}" realtor ${p.city} phone`);

const out = [
  ['Name', 'License Type', 'Licensed', 'County', 'City', 'Phone (enrich)', 'Google (phone lookup)', 'Called?', 'Notes', 'Mailing Address', 'Zip'].map(esc).join(','),
  ...pick.map((p) =>
    [p.name, p.type, fmt(p.licensed), p.county, p.city, '', lookup(p), '', '', p.address, p.zip].map(esc).join(',')
  ),
].join('\n');
writeFileSync(outFile, out);

const byCounty = {};
for (const p of pick) byCounty[p.county] = (byCounty[p.county] || 0) + 1;
console.log(`\n✓ ${pick.length} newly licensed ${includeBrokers ? 'agents/brokers' : 'sales associates'} in the last ${days} days.`);
console.log('  By county:', Object.entries(byCounty).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}=${n}`).join('  ') || '(none)');
console.log(`  → ${outFile}  (click the Google column to find each cell, then dial newest-first)\n`);
console.log('  Reminder: dial manually (no autodialer/prerecorded), and partner for referrals — never pay for them (RESPA §8).\n');
