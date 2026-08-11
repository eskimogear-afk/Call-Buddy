# Facebook / Instagram Ads Playbook — DSCR Florida

The landing page is built to be the conversion engine for paid social. This is
the step-by-step to run **compliant, optimized** Meta ads for DSCR loans.

> ⚠️ Order of operations (from the project scope): prove the form converts with
> organic + Google Ads FIRST, then scale with Meta. Don't pour ad spend into a
> page that hasn't converted a single organic lead yet.

---

## 0. Hard compliance gates (do these or the account gets banned)

1. **Declare the Housing Special Ad Category.** Mortgage/housing ads MUST be
   created under Special Ad Category → *Housing*. This is non-negotiable.
   - It **removes** age, gender, and ZIP targeting and forces a **15-mile
     minimum** radius. Plan creative/targeting around that.
2. **NMLS in the creative.** Put "Damon, NMLS #2291737 · Visto Mortgage, NMLS
   #[COMPANY_NMLS]" in the ad (helps approval and is required disclosure).
3. **Visto sign-off** on the ad copy + the landing page (Phase 0).
4. **Equal Housing** language/logo where required.

---

## 1. Accounts & tracking setup (one-time)

| What | Where | Note |
|------|-------|------|
| Meta Business Manager | business.facebook.com | umbrella account |
| Facebook Page | — | ads must run from a Page |
| Ad Account | Business Settings | |
| **Meta Pixel** | Events Manager → Data Sources | copy the **Pixel ID** |
| **Conversions API token** | Events Manager → Pixel → Settings → Conversions API | copy the **access token** |

Then wire them into this project:

- **`config.js`** → set `metaPixel: '<PIXEL_ID>'` (turns the browser Pixel on).
- **Vercel env vars** → `META_PIXEL_ID=<PIXEL_ID>` and
  `META_CONVERSIONS_TOKEN=<token>` (turns server-side CAPI on).

That's it — the code already fires the events below.

---

## 2. Events already wired (optimize ads on these)

| Event | Fires when | Use it for |
|-------|-----------|------------|
| `PageView` | every visit | retargeting audience |
| `ViewContent` | visitor clicks "Get my exact rate" on the calculator | mid-funnel / warm audience |
| `Contact` | visitor taps any call button | call-intent audience |
| **`Lead`** | form submitted (Pixel **+** server CAPI, deduplicated) | **campaign optimization goal** |

Optimize your campaign for the **Lead** event. Because it also fires server-side
(Conversions API), attribution holds up under iOS/ad-blockers.

Verify in **Events Manager → Test Events** after deploying: submit the form and
you should see ONE deduplicated Lead (browser + server share an `event_id`).

---

## 3. Campaign structure (start simple)

- **Objective:** Leads.
- **Special Ad Category:** Housing (mandatory).
- **Two ways to capture — test both:**
  1. **Instant Form** (in-app) — cheapest leads, lowest friction. Mirror the
     landing-page fields. Set up an automation to text new Instant-Form leads
     fast (or check them constantly — speed-to-lead still wins).
  2. **Conversion → landing page** — sends to the site, optimizes for `Lead`.
     Higher intent, uses the calculator. Best once the Pixel has ~50 leads.
- **One persona per campaign.** DSCR/investor ads NEVER mixed with consumer-loan
  ads.
- **Targeting (what still works under Housing category):** FL metro radius
  (15-mi min) around Orlando/Tampa/Jacksonville + interests: *real estate
  investing, BiggerPockets, Zillow, rental property, Airbnb hosting*.
- **Retarget** site visitors (Pixel audience) + Instagram/FB engagers — warmest,
  cheapest leads.

---

## 4. Creative (educate, don't sell)

Angle that works for DSCR: **"qualify on the rental's income, not your tax
returns."**

- Hook: *"Denied for a rental loan because of your tax write-offs? Your
  property's income can qualify instead."*
- Format: short **video with your face** (you, the LO) outperforms static.
- Always include the NMLS line in the creative.
- CTA: "Get my rate" → Instant Form or landing page.

---

## 5. Budget & kill rules (from the scope)

- Start **$10–20/day** per test.
- Benchmark: DSCR leads run **$15–60** on Meta. Your calculator page should beat
  the high end.
- **Kill rule:** if cost-per-lead stays > ~$80 after a meaningful test, pause and
  fix the **page/creative**, not the budget.

---

## 6. Pre-launch checklist

- [ ] Pixel ID in `config.js`; `META_PIXEL_ID` + `META_CONVERSIONS_TOKEN` in Vercel
- [ ] Test Events shows deduplicated `Lead` (browser + server)
- [ ] Special Ad Category = Housing
- [ ] NMLS in every creative; Visto disclaimer on page + ad
- [ ] Landing page has converted real organic leads first
- [ ] One persona per campaign; retargeting audience building from the Pixel
