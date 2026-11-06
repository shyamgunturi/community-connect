'use strict';
/**
 * UK location search used by the location autocomplete and distance search.
 *
 * Providers (in order):
 *  1. postcodes.io — free, open UK government data (ONS / Ordnance Survey Open Names).
 *     Handles full postcodes, partial postcodes / districts and town & city names.
 *     Suitable for search-as-you-type.
 *  2. OpenStreetMap Nominatim — fallback ONLY for explicit searches (never for
 *     autocomplete, which its usage policy forbids). Requests are throttled to one
 *     per second for the whole application, identified with a User-Agent and cached.
 *  3. A small built-in list of UK towns — used only if the online services are unreachable.
 *
 * All requests go through this server so results are cached and the provider can
 * be switched by configuration without changing the frontend.
 */
const gazetteer = require('./gazetteer');
const { UK_POSTCODE_RE, inUk } = require('./validation');

const PARTIAL_POSTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]?(\s*\d[A-Z]?)?$/i;
const OUTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]?$/i;
const PLACE_TYPES = { City: 1, Town: 2, 'Suburban Area': 3, Village: 4, 'Other Settlement': 5, Hamlet: 6 };

class GeocodeUnavailableError extends Error {
  constructor(message) { super(message); this.status = 503; }
}

function createGeocoder(options) {
  const cache = new Map();
  const MAX_CACHE = 1000;
  let nominatimChain = Promise.resolve();
  let lastNominatimAt = 0;
  let nominatimQueue = 0;
  const stats = { postcodesRequests: 0, nominatimRequests: 0, cacheHits: 0 };

  function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (hit.expires < Date.now()) { cache.delete(key); return null; }
    cache.delete(key); cache.set(key, hit); // keep most recently used at the end
    stats.cacheHits++;
    return hit.value;
  }
  function cacheSet(key, value, ttlMs) {
    cache.set(key, { value, expires: Date.now() + ttlMs });
    while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
  }

  async function getJson(url, headers = {}) {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': options.userAgent, ...headers },
      signal: AbortSignal.timeout(options.timeoutMs)
    });
    if (res.status === 404) return { notFound: true };
    if (!res.ok) throw new GeocodeUnavailableError(`Location provider responded with ${res.status}.`);
    return res.json();
  }

  const round = n => Math.round(Number(n) * 1e6) / 1e6;
  const make = (label, name, type, lat, lon, source, extra = {}) => ({ label, name, type, lat: round(lat), lon: round(lon), source, ...extra });

  async function postcodeLookup(postcode) {
    stats.postcodesRequests++;
    const data = await getJson(`${options.postcodesUrl}/postcodes/${encodeURIComponent(postcode.replace(/\s+/g, ''))}`);
    if (data.notFound || !data.result || data.result.latitude == null) return [];
    const r = data.result;
    const area = r.admin_district || r.parish || r.region || r.country || '';
    return [make(`${r.postcode}${area ? ', ' + area : ''}`, r.postcode, 'Postcode', r.latitude, r.longitude, 'postcodes.io', { postcode: r.postcode, area })];
  }

  async function partialPostcode(q) {
    const out = [];
    const compact = q.replace(/\s+/g, '').toUpperCase();
    if (OUTCODE_RE.test(compact)) {
      stats.postcodesRequests++;
      const oc = await getJson(`${options.postcodesUrl}/outcodes/${encodeURIComponent(compact)}`);
      if (!oc.notFound && oc.result && oc.result.latitude != null) {
        const district = Array.isArray(oc.result.admin_district) ? oc.result.admin_district[0] : oc.result.admin_district;
        out.push(make(`${oc.result.outcode} postcode district${district ? ', ' + district : ''}`, oc.result.outcode, 'Postcode district',
          oc.result.latitude, oc.result.longitude, 'postcodes.io', { area: district || '' }));
      }
    }
    stats.postcodesRequests++;
    const data = await getJson(`${options.postcodesUrl}/postcodes?q=${encodeURIComponent(q)}&limit=6`);
    for (const r of (data && Array.isArray(data.result) ? data.result : [])) {
      if (r.latitude == null) continue;
      const area = r.admin_district || r.region || '';
      out.push(make(`${r.postcode}${area ? ', ' + area : ''}`, r.postcode, 'Postcode', r.latitude, r.longitude, 'postcodes.io', { postcode: r.postcode, area }));
    }
    return out.slice(0, 6);
  }

  async function placeSearch(q) {
    stats.postcodesRequests++;
    const data = await getJson(`${options.postcodesUrl}/places?q=${encodeURIComponent(q)}&limit=30`);
    const list = (data && Array.isArray(data.result) ? data.result : [])
      .filter(p => PLACE_TYPES[p.local_type] && p.latitude != null);
    const lower = q.toLowerCase();
    const score = p => {
      const n = String(p.name_1 || '').toLowerCase();
      const match = n === lower ? 0 : n.startsWith(lower) ? 1 : 2;
      return match * 10 + PLACE_TYPES[p.local_type];
    };
    list.sort((a, b) => score(a) - score(b));
    const seen = new Set();
    const out = [];
    for (const p of list) {
      const area = p.county_unitary || p.district_borough || p.region || p.country || '';
      const label = `${p.name_1}${area && area !== p.name_1 ? ', ' + area : ''}`;
      if (seen.has(label)) continue;
      seen.add(label);
      out.push(make(label, p.name_1, p.local_type, p.latitude, p.longitude, 'postcodes.io', { area }));
      if (out.length === 6) break;
    }
    return out;
  }

  function nominatimSearch(q) {
    if (nominatimQueue >= 5) return Promise.reject(new GeocodeUnavailableError('Location search is busy. Please try again in a moment.'));
    nominatimQueue++;
    const run = nominatimChain.then(async () => {
      const wait = lastNominatimAt + 1100 - Date.now(); // ≤ 1 request per second, application-wide
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      lastNominatimAt = Date.now();
      stats.nominatimRequests++;
      const email = options.contactEmail ? `&email=${encodeURIComponent(options.contactEmail)}` : '';
      const data = await getJson(`${options.nominatimUrl}/search?format=jsonv2&countrycodes=gb&limit=5&q=${encodeURIComponent(q)}${email}`, { 'Accept-Language': 'en-GB' });
      return (Array.isArray(data) ? data : [])
        .filter(r => inUk(Number(r.lat), Number(r.lon)))
        .map(r => {
          const parts = String(r.display_name || '').split(',').map(s => s.trim());
          return make(parts.slice(0, 2).join(', '), parts[0], r.addresstype || r.type || 'Place', r.lat, r.lon, 'nominatim', { attribution: '© OpenStreetMap contributors' });
        });
    }).finally(() => { nominatimQueue--; });
    nominatimChain = run.catch(() => {});
    return run;
  }

  function offlineSearch(q) {
    const lower = q.toLowerCase();
    return gazetteer
      .filter(t => t.name.toLowerCase().startsWith(lower) || (lower.length >= 3 && t.name.toLowerCase().includes(lower)))
      .slice(0, 6)
      .map(t => make(`${t.name}, ${t.area}`, t.name, 'Town', t.lat, t.lon, 'offline'));
  }

  /**
   * @param {string} raw    user input
   * @param {object} opts   mode: 'suggest' (autocomplete) or 'search' (explicit submit)
   * @returns {Promise<{results: object[], source: string, message?: string}>}
   */
  async function search(raw, { mode = 'suggest' } = {}) {
    const q = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (q.length < 2) return { results: [], source: 'none', message: 'Type at least two characters.' };
    const key = `${mode}:${q.toLowerCase()}`;
    const cached = cacheGet(key);
    if (cached) return cached;

    let results = [];
    let upstreamFailed = false;
    let isPostcode = false;
    try {
      if (UK_POSTCODE_RE.test(q)) { isPostcode = true; results = await postcodeLookup(q); }
      else if (PARTIAL_POSTCODE_RE.test(q)) results = await partialPostcode(q);
      else results = await placeSearch(q);
    } catch (err) {
      upstreamFailed = true;
      console.warn('[geocode] postcodes.io unavailable:', err.message);
    }

    if (!results.length && mode === 'search' && options.nominatimEnabled && !isPostcode) {
      try { results = await nominatimSearch(q); upstreamFailed = false; }
      catch (err) { console.warn('[geocode] Nominatim unavailable:', err.message); }
    }

    if (!results.length && upstreamFailed && options.offlineFallback) {
      results = offlineSearch(q);
      if (results.length) {
        return { results, source: 'offline', message: 'Online location search is unavailable, so an approximate built-in town list was used.' };
      }
    }

    if (!results.length && upstreamFailed) {
      throw new GeocodeUnavailableError('Location search is temporarily unavailable. Check your internet connection and try again.');
    }

    const value = results.length
      ? { results, source: results[0].source }
      : { results: [], source: 'none', message: isPostcode ? 'We could not find that postcode. Check it and try again.' : 'No UK town, city or postcode matched your search.' };
    cacheSet(key, value, results.length ? 24 * 3600e3 : 3600e3);
    return value;
  }

  return { search, stats, _cache: cache };
}

module.exports = { createGeocoder, GeocodeUnavailableError };
