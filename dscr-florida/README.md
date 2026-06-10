# DSCR Florida Lead Machine

A self-owned, organic-first lead system for **DSCR investor loans in Florida**.
A polished landing page (the "money page") with an instant rent + DSCR
calculator, a lead-capture form, and a backend that drops every lead into
Supabase and **texts you within seconds** so you can call back first.

> **Exit criterion:** form submit → Supabase row → 🔥 text on your phone in <10 sec.

## Stack

- **Front end:** static HTML/CSS/JS (`index.html`, `styles.css`, `app.js`) — no build step.
- **Backend:** Vercel serverless functions in `/api`.
  - `POST /api/lead` — validate → insert into `mortgage_leads` → instant Twilio text.
  - `GET /api/rent-estimate?address=` — RentCast proxy (key stays server-side).
- **Data:** Supabase (`mortgage_leads` table — see `db/schema.sql`).
- **Deploy:** Vercel + a custom domain.

## Quick start (local)

```bash
cd dscr-florida
npm install
cp .env.example .env        # fill in your keys
npx vercel dev              # serves the page + /api on http://localhost:3000
```

1. **Create the table:** open the Supabase SQL editor and run `db/schema.sql`.
2. **Test the backend:**
   ```bash
   curl -s -X POST http://localhost:3000/api/lead \
     -H 'Content-Type: application/json' \
     -d '{"name":"Test Investor","phone":"+15555550123","city":"Orlando","loan_purpose":"purchase","estimated_rent":2400,"dscr_ratio":1.12}'
   ```
   Expect `{"ok":true,"id":"…"}`, a new row in `mortgage_leads`, and a text to
   `LEAD_NOTIFY_PHONE` (defaults to **+1 754-256-6781**).
3. **Test the calculator:**
   ```bash
   curl -s 'http://localhost:3000/api/rent-estimate?address=123+Main+St,+Orlando,+FL'
   ```
   With no `RENTCAST_API_KEY` set you'll get `{"available":false,...}` and the
   page falls back to manual rent entry — that's expected.

## Environment variables

See `.env.example`. Set the same vars in the Vercel dashboard for production.
Front-end IDs (analytics, phone, company NMLS) are edited directly in
`index.html` — search the file for `TODO`.

| Where | What to fill in |
|-------|-----------------|
| `.env` / Vercel | Supabase, Twilio, RentCast keys, `LEAD_NOTIFY_PHONE` |
| `index.html` | `GA4_MEASUREMENT_ID` *or* Plausible domain, `META_PIXEL_ID`, `GSC_VERIFICATION_TOKEN`, displayed phone (`tel:` links + text), `YOUR-DOMAIN.com`, `[COMPANY_NMLS]`, disclaimer wording |
| `robots.txt`, `sitemap.xml` | `YOUR-DOMAIN.com` |

## Free things to install (Phase 1)

- **Google Search Console** — verify with the `<meta google-site-verification>`
  tag in `index.html`, then submit `sitemap.xml`.
- **GA4 or Plausible** — uncomment one analytics block in `index.html`.
- **Meta Pixel** — uncomment the Pixel block. It builds a retargeting audience
  from day 1, even before you run ads. `app.js` already fires `Lead` + custom
  events.
- **RentCast** ([rentcast.io](https://rentcast.io)) — free tier 50 calls/mo.
  Add `RENTCAST_API_KEY` to turn the calculator into a real lead magnet.

## Deploy

```bash
npx vercel            # first deploy / link project
npx vercel --prod     # production
```

Then connect your domain in the Vercel dashboard and update the `YOUR-DOMAIN.com`
placeholders + `<link rel="canonical">` / OG URLs.

## ⚠️ Compliance gate (Phase 0 — do before going live)

This page ships with **placeholder** compliance text. Before advertising:

- [ ] Confirm broker authority to **advertise/originate FL investor loans**
      (currently licensed IL/IN/MI — if no, retarget Midwest keywords, ~1 hr edits).
- [ ] Get Visto's required ad elements: **company NMLS #, logo, exact disclaimer
      wording** — fill the `[COMPANY_NMLS]`, `[STATES]`, and `[DISCLAIMER
      PLACEHOLDER]` slots in the footer of `index.html`.
- [ ] Get written sign-off on the landing page.
- [ ] Ask: any restrictions on running paid ads under your NMLS?

Damon's NMLS **#2291737** is already in the page. The company NMLS and disclaimer
are the only blocking blanks.

## Notes

- A failed text never fails the lead save — the lead is the asset.
- `mortgage_leads` has RLS on; only the server (service-role key) can write.
  The public anon key can do nothing.
