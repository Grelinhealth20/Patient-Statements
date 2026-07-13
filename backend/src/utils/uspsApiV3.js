import { env } from '../config/env.js';
import { splitAddress, buildUspsStatus, UspsValidationError } from './uspsValidation.js';

/**
 * PRIMARY address validator — USPS APIs v3 (the current USPS platform).
 *
 *   Token:    POST {apiBase}/oauth2/v3/token   (OAuth2 client_credentials, scope "addresses")
 *   Validate: GET  {apiBase}/addresses/v3/address?streetAddress=…&state=…&city=…&ZIPCode=…
 *
 * Auth is a Consumer Key (clientId) + Consumer Secret (clientSecret) from
 * developer.usps.com; the access token is a JWT minted automatically and cached in
 * memory until shortly before it expires. Everything is server-side only — no USPS
 * credential or token ever reaches the browser.
 *
 * On success this returns the SAME normalized shape as the Google extractor
 * (line1/line2/formatted/complete/verdictText…) so the resolver/DB path is
 * provider-agnostic. When USPS cannot identify an address accurately it throws
 * `UspsValidationError`, and the resolver falls back to Google.
 */

const DEFAULT_TIMEOUT_MS = 10000;
const TOKEN_SKEW_MS = 60 * 1000; // refresh a minute before expiry

const s = (v) => (v == null ? '' : String(v)).trim();

/** True when the USPS APIs v3 OAuth credentials are configured. */
export function isUspsV3Configured() {
  return !!(env.usps.clientId && env.usps.clientSecret);
}

/** Bounded fetch that never hangs a request thread. */
async function timedFetch(url, opts = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------ OAuth token cache */

// In-memory access-token cache + a single in-flight refresh promise so that many
// concurrent callers who all find the token expired trigger exactly ONE token POST
// (the rest await the same refresh) instead of a thundering herd.
let _token = { value: '', expiresAt: 0 };
let _inflight = null;

/** True when a cached token exists and is still within its (skew-adjusted) lifetime. */
function tokenIsFresh(now = Date.now()) {
  return !!_token.value && now < _token.expiresAt;
}

/** Perform the actual client_credentials token request and populate the cache. */
async function requestNewToken() {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env.usps.clientId,
    client_secret: env.usps.clientSecret,
    scope: 'addresses',
  });

  let res;
  try {
    res = await timedFetch(`${env.usps.apiBase}/oauth2/v3/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new UspsValidationError('USPS token request timed out.', 'TIMEOUT');
    throw new UspsValidationError(`Could not reach USPS OAuth: ${err.message}`, 'UPSTREAM');
  }

  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.access_token) {
    const detail = json?.error_description || json?.error || `HTTP ${res.status}`;
    throw new UspsValidationError(`USPS OAuth failed: ${detail}`, 'AUTH');
  }

  // expires_in is seconds. Cache until TOKEN_SKEW_MS before expiry so we always
  // hand out a token with comfortable headroom, refreshing proactively.
  const ttlMs = Number(json.expires_in) > 0 ? Number(json.expires_in) * 1000 : 8 * 3600 * 1000;
  _token = { value: json.access_token, expiresAt: Date.now() + ttlMs - TOKEN_SKEW_MS };
  return _token.value;
}

/**
 * Obtain a valid OAuth2 access token via the client_credentials flow.
 *
 * The token is minted automatically and cached in memory; it is regenerated whenever
 * it is missing, has passed its (skew-adjusted) expiry, or a caller forces a refresh
 * after a 401. Concurrent refreshes are coalesced into one network call.
 *
 * @param {{force?: boolean}} [opts]  force:true bypasses the cache (used after a 401).
 */
export async function getUspsAccessToken({ force = false } = {}) {
  if (!isUspsV3Configured()) {
    throw new UspsValidationError('USPS APIs v3 is not configured (missing Consumer Key/Secret).', 'NOT_CONFIGURED');
  }
  // Serve the cached token while it is still fresh (unless a refresh is forced).
  if (!force && tokenIsFresh()) return _token.value;

  // A forced refresh must not reuse a refresh that began against the now-stale token.
  if (force) _inflight = null;

  // Coalesce: the first caller kicks off the refresh; everyone else awaits it. The
  // in-flight promise is always cleared once settled so the next expiry re-refreshes.
  if (!_inflight) {
    _inflight = requestNewToken().finally(() => { _inflight = null; });
  }
  return _inflight;
}

/** Diagnostics: current token state (never exposes the token value). */
export function getTokenState() {
  const now = Date.now();
  return {
    hasToken: !!_token.value,
    fresh: tokenIsFresh(now),
    expiresInSec: _token.value ? Math.max(0, Math.round((_token.expiresAt - now) / 1000)) : 0,
    refreshing: !!_inflight,
  };
}

/* -------------------------------------------------------- address validation */

/** USPS DPV → human verdict. Y/S/D = deliverable (confirmed); N = not confirmed. */
function dpvVerdict(dpv, exact, hasZip4) {
  const c = s(dpv).toUpperCase();
  if (exact) return { complete: true, text: 'Confirmed (USPS v3 — exact match)' };
  if (c === 'Y') return { complete: true, text: 'Confirmed (USPS v3 DPV)' };
  if (c === 'S') return { complete: true, text: 'Confirmed (USPS v3 DPV — secondary unneeded)' };
  if (c === 'D') return { complete: false, text: 'Confirmed street (USPS v3 DPV — secondary missing)' };
  if (c === 'N') return { complete: false, text: 'Not confirmed (USPS v3 DPV)' };
  return { complete: hasZip4, text: hasZip4 ? 'Standardized (USPS v3, ZIP+4)' : 'Standardized (USPS v3)' };
}

/**
 * Validate a patient's address with USPS APIs v3. Returns the normalized standardized
 * address on success, or throws `UspsValidationError` when USPS cannot identify it
 * accurately (so the caller can fall back to Google).
 *
 * @param {{line1?: string, line2?: string}} input
 * @param {object} [opts]  { timeoutMs?, _retried? }
 */
export async function validateAddressUspsV3({ line1, line2 } = {}, opts = {}) {
  if (!isUspsV3Configured()) {
    throw new UspsValidationError('USPS APIs v3 is not configured.', 'NOT_CONFIGURED');
  }

  const { street, secondary, city, state, zip5, zip4 } = splitAddress(line1, line2);
  // v3 requires streetAddress + state, plus at least a city or a ZIP to resolve.
  if (!street || !state || (!zip5 && !city)) {
    throw new UspsValidationError('Not enough address detail for USPS to validate (need street, state, and city or ZIP).', 'INSUFFICIENT_INPUT');
  }

  const params = new URLSearchParams({ streetAddress: street, state });
  if (secondary) params.set('secondaryAddress', secondary);
  if (city) params.set('city', city);
  if (zip5) params.set('ZIPCode', zip5);
  if (zip4) params.set('ZIPPlus4', zip4);

  const token = await getUspsAccessToken();
  const url = `${env.usps.apiBase}/addresses/v3/address?${params.toString()}`;

  let res;
  try {
    res = await timedFetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    }, opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  } catch (err) {
    if (err.name === 'AbortError') throw new UspsValidationError('USPS validation timed out.', 'TIMEOUT');
    throw new UspsValidationError(`Could not reach USPS: ${err.message}`, 'UPSTREAM');
  }

  // A 401 can mean the cached token was revoked early — refresh once and retry.
  if (res.status === 401 && !opts._retried) {
    await getUspsAccessToken({ force: true });
    return validateAddressUspsV3({ line1, line2 }, { ...opts, _retried: true });
  }

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = json?.error?.message || json?.error_description || json?.message || `HTTP ${res.status}`;
    const code = res.status === 401 || res.status === 403 ? 'AUTH'
      : res.status === 400 ? 'INSUFFICIENT_INPUT'
        : res.status === 404 ? 'NOT_FOUND'
          : 'UPSTREAM';
    throw new UspsValidationError(`USPS v3: ${detail}`, code);
  }

  const a = json?.address || {};
  const info = json?.additionalInfo || {};
  const matches = Array.isArray(json?.matches) ? json.matches : [];
  const corrections = Array.isArray(json?.corrections) ? json.corrections : [];

  const outStreet = s(a.streetAddress);
  const outSecondary = s(a.secondaryAddress);
  const outCity = s(a.city);
  const outState = s(a.state);
  const outZip5 = s(a.ZIPCode);
  const outZip4 = s(a.ZIPPlus4);
  const dpv = s(info.DPVConfirmation).toUpperCase();

  // A usable result must carry a standardized street, city, state and ZIP5.
  if (!outStreet || !outCity || !outState || !outZip5) {
    throw new UspsValidationError('USPS returned an incomplete address.', 'NOT_FOUND');
  }
  // Code 22 = multiple addresses / no default → ambiguous, cannot resolve accurately.
  if (corrections.some((c) => s(c.code) === '22')) {
    throw new UspsValidationError('USPS found multiple addresses; could not resolve accurately.', 'NOT_FOUND');
  }
  // DPV "N" = not a confirmed deliverable address.
  if (dpv === 'N') {
    throw new UspsValidationError('USPS could not confirm this address is deliverable.', 'UNCONFIRMED');
  }

  const exact = matches.some((m) => s(m.code) === '31'); // Single Response - exact match
  const outLine1 = [outStreet, outSecondary].filter(Boolean).join(' ');
  const zip = outZip4 ? `${outZip5}-${outZip4}` : outZip5;
  const outLine2 = `${outCity}, ${outState} ${zip}`;
  const verdict = dpvVerdict(dpv, exact, !!outZip4);

  return {
    line1: outLine1,
    line2: outLine2,
    formatted: `${outLine1}, ${outLine2}`,
    complete: verdict.complete,
    hasUnconfirmed: corrections.length > 0 && !exact,
    hasInferred: !!outZip4,
    verdictText: verdict.text,
    provider: 'usps',
    dpv: dpv || null,
    zipPlus4: !!outZip4,
    exactMatch: exact,
  };
}

/** Provider-labelled real-time status descriptor for the popup (USPS v3, free). */
export function buildUspsV3Status(validated = null) {
  return buildUspsStatus(validated, 'USPS Addresses API v3');
}

/* ----------------------------------------------------------------- health */

let _health = { at: 0, healthy: false, reason: null };
const HEALTH_TTL_MS = 5 * 60 * 1000;

/**
 * Live USPS v3 health probe (cached briefly) so the client pill reflects whether USPS
 * is ACTUALLY serving right now. Validates a stable, deliverable address.
 */
export async function probeUspsV3Health({ force = false } = {}) {
  if (!isUspsV3Configured()) return { configured: false, healthy: false, reason: 'USPS APIs v3 is not configured.' };
  const now = Date.now();
  if (!force && _health.at && now - _health.at < HEALTH_TTL_MS) {
    return { configured: true, healthy: _health.healthy, reason: _health.reason, cached: true, checkedAt: new Date(_health.at).toISOString() };
  }
  try {
    await validateAddressUspsV3({ line1: '6105 N Wickham Rd # 410253', line2: 'Melbourne, FL 32941' }, { timeoutMs: 6000 });
    _health = { at: now, healthy: true, reason: null };
  } catch (err) {
    _health = { at: now, healthy: false, reason: `${err.code || 'ERROR'}: ${err.message}` };
  }
  return { configured: true, healthy: _health.healthy, reason: _health.reason, cached: false, checkedAt: new Date(now).toISOString() };
}
