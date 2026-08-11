// GET /api/rent-estimate?address=123+Main+St,+Orlando,+FL
// Server-side proxy to the RentCast long-term rent AVM. Keeps RENTCAST_API_KEY
// secret and shields the 50-calls/mo free tier behind a small in-memory cache.
//
// The calculator degrades gracefully: if the key is missing/exhausted or the
// address can't be valued, we return { available: false } and the front end
// lets the visitor type the rent in manually. The lead is never blocked on this.

const RENTCAST_URL = 'https://api.rentcast.io/v1/avm/rent/long-term';
const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24h — addresses don't move

// Module-scoped cache. Survives warm invocations on the same Vercel instance.
const cache = new Map();

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')
    return res.status(405).json({ error: 'Method not allowed' });

  const address = (req.query.address || '').toString().trim();
  if (!address)
    return res.status(400).json({ available: false, error: 'Missing address' });

  if (!process.env.RENTCAST_API_KEY) {
    // Not configured yet — tell the client to fall back to manual entry.
    return res.status(200).json({ available: false, reason: 'not_configured' });
  }

  const key = address.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) {
    return res.status(200).json({ ...hit.data, cached: true });
  }

  try {
    const url = `${RENTCAST_URL}?address=${encodeURIComponent(address)}`;
    const r = await fetch(url, {
      headers: { 'X-Api-Key': process.env.RENTCAST_API_KEY, accept: 'application/json' },
    });

    if (r.status === 429) {
      // Monthly quota hit — fail soft so the calculator still works.
      return res.status(200).json({ available: false, reason: 'rate_limited' });
    }
    if (!r.ok) {
      return res.status(200).json({ available: false, reason: 'no_estimate' });
    }

    const json = await r.json();
    const rent = Number(json.rent);
    if (!Number.isFinite(rent) || rent <= 0) {
      return res.status(200).json({ available: false, reason: 'no_estimate' });
    }

    const data = {
      available: true,
      rent: Math.round(rent),
      low: json.rentRangeLow ? Math.round(Number(json.rentRangeLow)) : null,
      high: json.rentRangeHigh ? Math.round(Number(json.rentRangeHigh)) : null,
    };
    cache.set(key, { t: Date.now(), data });
    return res.status(200).json(data);
  } catch (err) {
    console.error('RentCast lookup failed:', err);
    return res.status(200).json({ available: false, reason: 'error' });
  }
}
