# 🚀 DSCR Florida — Launch Runbook

Follow top to bottom. ⏱️ ≈ 60–90 min of account setup. Items marked **(you)**
need your login/payment; everything in the code is already done.

---

## 0. ⚠️ Compliance gate (do not run public ads until done)

- [ ] Visto authority to advertise/originate **FL** investor loans (you're
      licensed IL/IN/MI — if no, ~1 hr pivot to Midwest keywords).
- [ ] Get Visto's **company NMLS #** + **exact disclaimer wording** + licensed states.
- [ ] Written sign-off on the landing page.

You can deploy + test privately before this; just don't drive public traffic yet.

---

## 1. Deploy on Vercel **(you)**

The DSCR site lives in the `dscr-florida/` subfolder, so it needs its **own**
Vercel project (separate from PitchLog):

1. vercel.com → **Add New… → Project** → import the `Call-Buddy` repo.
2. **Root Directory** → click *Edit* → choose **`dscr-florida`**. ← the key step
3. Framework preset: **Other**. Deploy.
4. You'll get a `*.vercel.app` URL — that's your live page.

> CLI alternative: `cd dscr-florida && npx vercel --prod`

---

## 2. Supabase **(you)** — lead storage

1. supabase.com → **New project** (free tier is fine).
2. **SQL Editor** → paste the contents of `db/schema.sql` → Run. (Creates the
   `mortgage_leads` table with RLS.)
3. **Project Settings → API** → copy the **Project URL** and the
   **`service_role` key** (secret).

---

## 3. Twilio **(you)** — the instant 🔥 text

1. Upgrade off trial (~$20) and buy a phone number.
2. Register **A2P 10DLC** (required for US SMS — uses your business identity).
3. Settings → copy **Account SID** + **Auth Token**, and note the **From** number.
4. `LEAD_NOTIFY_PHONE` is already your cell (**+1 754-256-6781**).

---

## 4. Set Vercel environment variables **(you)**

Project → **Settings → Environment Variables**. Add:

| Variable | From |
|---|---|
| `SUPABASE_URL` | step 2 |
| `SUPABASE_SERVICE_KEY` | step 2 (service_role) |
| `TWILIO_ACCOUNT_SID` | step 3 |
| `TWILIO_AUTH_TOKEN` | step 3 |
| `TWILIO_PHONE_NUMBER` | step 3 (your From #, e.g. +1407…) |
| `LEAD_NOTIFY_PHONE` | `+17542566781` |
| `RENTCAST_API_KEY` | step 6 (optional) |
| `META_PIXEL_ID` | step 7 (for ads) |
| `META_CONVERSIONS_TOKEN` | step 7 (for ads) |

**Redeploy** after adding env vars.

---

## 5. Fill `config.js` **(I can do this — just send me the values)**

```js
phoneDisplay: '(407) 555-1234',  phoneE164: '+14075551234',
companyNmls: '1234567',          states: 'Florida',
domain: 'https://your-domain.com',
ga4: 'G-XXXXXXXXXX',  metaPixel: '123456789012345',
```

Also set the real domain in `index.html` `<head>` (`og:*` tags + GSC token) —
social/Google crawlers read those statically.

---

## 6. RentCast **(you, optional but recommended)**

rentcast.io → free tier (50 calls/mo) → API key → `RENTCAST_API_KEY`. Turns the
calculator into an address-based rent estimate.

---

## 7. Analytics + Pixel **(you create, I've wired the code)**

- **GA4 or Plausible** → put the ID in `config.js` (`ga4` or `plausible`).
- **Google Search Console** → verify with the `<meta>` token in `index.html`,
  then submit `sitemap.xml`.
- **Meta Pixel** (for ads) → Events Manager → create Pixel → put ID in
  `config.js` (`metaPixel`) **and** `META_PIXEL_ID`; create a Conversions API
  token → `META_CONVERSIONS_TOKEN`. (See `FACEBOOK-ADS.md`.)

---

## 8. Connect your domain **(you)**

Vercel project → **Domains** → add your domain → follow DNS steps. Then update
the `YOUR-DOMAIN.com` placeholders in `index.html`, `sitemap.xml`, `robots.txt`.

---

## 9. ✅ Final smoke test

1. Open the live page → run the calculator → submit the form.
2. Confirm: a row in Supabase `mortgage_leads` **and** a 🔥 text to your cell
   within ~10 sec.
3. (Ads) Events Manager → **Test Events** → submit again → see ONE deduplicated
   `Lead` (browser + server share `event_id`).

**That's live.** Now turn on traffic — see `marketing/go-live-copy.md` (start
with cold-call follow-up links + email signature; ads come later, after the page
proves it converts).
