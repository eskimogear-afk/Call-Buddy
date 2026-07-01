# New-Realtor Prospecting Toolkit (Central Florida)

Goal: find newly licensed / newly active agents to call and build referral
partnerships (they send you investor clients who need DSCR loans).

## The honest landscape

- **Individual "Company welcomes new agent [Name]" posts** live on LinkedIn /
  Facebook / Instagram. Those platforms block automated scraping (ToS) and
  aren't reliably indexed by web search, so there's **no clean, legal way to
  bulk-scrape them**. Anyone selling you a "scraped 3-year list" is either
  using a paid licensee-data service or violating platform terms.
- **The authoritative, legal individual-level source is FL DBPR** (the weekly
  licensee CSV). Use `new-realtors.mjs` for that — it's the backbone.
- **Brokerage "join our team" pages + team rosters** are the best *public*
  proxy for "where new agents are." That's the list below.

## Tier 1 — Run the DBPR script (authoritative)

Download the licensee CSV from the FL DBPR Real Estate Commission public records
page, then:

    node new-realtors.mjs ./dbpr_real_estate.csv --days 60 \
      --counties "ORANGE,OSCEOLA,SEMINOLE,LAKE,POLK"

→ every newly licensed agent in your counties, newest first.

## Tier 2 — Target recruiting brokerages & team rosters

See `fl-new-agent-sources.csv`. These companies either actively recruit new
agents or carry large rosters with frequent new joiners. Pull their "our team /
agents" pages and cross-reference names against your DBPR list (recent license
date = new agent) to prioritize.

## Tier 3 — Set up ongoing monitoring (set once, runs forever)

**Google Alerts** (free — alerts.google.com). Create one per query:

- `"welcome to the team" realtor Orlando`
- `"newly licensed" realtor Orlando OR Kissimmee OR "Winter Garden"`
- `"just got my real estate license" Orlando`
- `"joining" "Keller Williams" OR "eXp" OR "Compass" agent Orlando`
- `Orlando realtor "first listing"`

**LinkedIn search** (manual, ToS-safe — no bots). Saved searches:

- People · Title "Realtor" OR "Real Estate Agent" · Location "Orlando, FL" ·
  sort by "recently joined / new" and check "started new position in last 90 days"
- Filter by the brokerages in Tier 2.

**Brokerage news/blog pages** — bookmark and check monthly; new-agent
announcements often post here before anywhere indexable.

## Phone enrichment (DBPR has no phone numbers)

For each name: search `"<full name>" realtor <city> phone` → brokerage profile,
Realtor.com/Zillow profile, or Google Business listing usually has the cell.
(Ask me to add an auto-generated Google-search link column to the call sheet.)

## Compliance (you're a licensed MLO — keep it clean)

- **Dial manually.** No autodialer / prerecorded messages (TCPA). Person-to-
  person B2B calls to agents are standard.
- **Partner, never pay.** RESPA §8 prohibits compensation for mortgage
  referrals. Co-marketing/MSAs have strict rules — networking is free and fine.
- **Respect platform ToS.** Use official search/alerts, not scraper bots, on
  LinkedIn/FB/IG.
