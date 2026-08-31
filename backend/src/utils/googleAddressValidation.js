import { env } from '../config/env.js';

/**
 * The SOLE address validator — the Google Cloud Address Validation API.
 * No other address-validation API is used anywhere in this app.
 *
 *   Validate: POST {apiBase}/v1:validateAddress?key={apiKey}
 *             body { address: { regionCode, addressLines[] }, enableUspsCass: true }
 *
 * Auth is a single Google API key (server-side only — it never reaches the browser).
 * With `enableUspsCass` the response carries USPS CASS data (a standardized delivery
 * address + DPV confirmation) alongside Google's own verdict/geocode, so we get the
 * postal-grade standardized address AND Google's completeness signals in one call.
 *
 * On success this returns a normalized shape (line1/line2/formatted/complete/
 * verdictText…) — identical to what the resolver/DB path already expects — so the
 * rest of the app is provider-agnostic. When Google cannot identify an address
 * accurately it throws `AddressValidationError`, which the caller surfaces to the
 * user — there is no fallback provider.
 */

const DEFAULT_TIMEOUT_MS = 10000;

const s = (v) => (v == null ? '' : String(v)).trim();

/** Structured error signalling that the address could not be accurately validated. */
export class AddressValidationError extends Error {
  constructor(message, code = '') {
    super(message);
    this.name = 'AddressValidationError';
    this.code = code; // NOT_CONFIGURED | INSUFFICIENT_INPUT | AUTH | NOT_FOUND | UNCONFIRMED | UPSTREAM | TIMEOUT
  }
}

/* ----------------------------------------------------------------- config */

/** True when the Google Address Validation API key is configured. */
export function isGoogleAvConfigured() {
  return !!s(env.google.apiKey);
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

/* -------------------------------------------------------- address validation */

/**
 * Map the Google/USPS-CASS signals to a human verdict + a completeness flag.
 * DPV (from USPS CASS) is the strongest deliverability signal when present:
 *   Y = deliverable · S = deliverable, secondary present but unneeded ·
 *   D = deliverable primary, secondary missing · N = not confirmed.
 * When DPV is absent we fall back to Google's own verdict granularity.
 */
function buildVerdict({ dpv, granularity, addressComplete, hasUnconfirmed, hasInferred, hasZip4 }) {
  const c = s(dpv).toUpperCase();
  if (c === 'Y') return { complete: true, text: 'Confirmed (Google + USPS DPV)' };
  if (c === 'S') return { complete: true, text: 'Confirmed (Google + USPS DPV — secondary unneeded)' };
  if (c === 'D') return { complete: false, text: 'Confirmed street (Google + USPS DPV — secondary missing)' };
  if (c === 'N') return { complete: false, text: 'Not confirmed (Google + USPS DPV)' };

  // No USPS DPV — lean on Google's verdict. Premise/sub-premise + complete = confirmed.
  const g = s(granularity).toUpperCase();
  const premise = g === 'PREMISE' || g === 'SUB_PREMISE';
  if (addressComplete && premise && !hasUnconfirmed) {
    return { complete: true, text: 'Confirmed (Google address validation)' };
  }
  if (addressComplete && !hasUnconfirmed) {
    return { complete: hasZip4, text: hasZip4 ? 'Standardized (Google, ZIP+4)' : 'Standardized (Google)' };
  }
  return { complete: false, text: hasInferred ? 'Standardized with inferred parts (Google)' : 'Standardized (Google)' };
}

/**
 * Compose the two output lines from the USPS-CASS standardized address when present
 * (postal-grade), otherwise from Google's own standardized postal address.
 */
function composeLines(usps, postal) {
  // Preferred: USPS CASS standardized address (delivery-point accurate). Build line2
  // as "City, ST ZIP[-4]" from the structured fields so it is properly punctuated and
  // consistent with the rest of the app (Google's cityStateZipAddressLine omits the
  // comma). Fall back to that raw line only if the structured fields are missing.
  const uLine1 = s(usps.firstAddressLine);
  if (uLine1) {
    const zip = s(usps.zipCode);
    const ext = s(usps.zipCodeExtension);
    const city = s(usps.city);
    const state = s(usps.state);
    const zipFull = ext ? `${zip}-${ext}` : zip;
    const line2 = (city && state)
      ? `${city}, ${state} ${zipFull}`.trim()
      : s(usps.cityStateZipAddressLine);
    return { line1: uLine1, line2, city, state, zip5: zip, zip4: ext };
  }

  // Fallback: Google's own standardized postalAddress.
  const lines = Array.isArray(postal.addressLines) ? postal.addressLines.map(s).filter(Boolean) : [];
  const line1 = lines.join(' ');
  const city = s(postal.locality);
  const state = s(postal.administrativeArea);
  const pc = s(postal.postalCode); // may be "32941" or "32941-1234"
  const [zip5, zip4] = pc.includes('-') ? pc.split('-') : [pc, ''];
  const line2 = `${city}, ${state} ${pc}`.trim().replace(/[,\s]+$/, '');
  return { line1, line2, city, state, zip5: s(zip5), zip4: s(zip4) };
}

/**
 * Validate a patient's address with the Google Address Validation API. Returns the
 * normalized standardized address on success, or throws `AddressValidationError` when
 * Google cannot identify it accurately (the caller surfaces the message; there is no
 * fallback provider).
 *
 * @param {{line1?: string, line2?: string}} input
 * @param {object} [opts]  { timeoutMs? }
 */
export async function validateAddressGoogle({ line1, line2 } = {}, opts = {}) {
  if (!isGoogleAvConfigured()) {
    throw new AddressValidationError('Google Address Validation is not configured (missing API key).', 'NOT_CONFIGURED');
  }

  const addressLines = [s(line1), s(line2)].filter(Boolean);
  if (!addressLines.length) {
    throw new AddressValidationError('No address supplied to validate.', 'INSUFFICIENT_INPUT');
  }

  const url = `${env.google.apiBase}/v1:validateAddress?key=${encodeURIComponent(env.google.apiKey)}`;
  const payload = {
    address: { regionCode: 'US', addressLines },
    // Enable USPS CASS processing so the response carries the postal-standardized
    // address + DPV confirmation (US addresses only).
    enableUspsCass: true,
  };

  let res;
  try {
    res = await timedFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    }, opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  } catch (err) {
    if (err.name === 'AbortError') throw new AddressValidationError('Google address validation timed out.', 'TIMEOUT');
    throw new AddressValidationError(`Could not reach Google: ${err.message}`, 'UPSTREAM');
  }

  const json = await res.json().catch(() => null);

  if (!res.ok) {
    const detail = json?.error?.message || json?.error?.status || `HTTP ${res.status}`;
    const gStatus = s(json?.error?.status).toUpperCase();
    // Google reports an invalid/expired/blocked API key as HTTP 400 INVALID_ARGUMENT
    // ("API key not valid…", reason API_KEY_INVALID) as well as via 401/403 — detect
    // the key problem from the body so it maps to AUTH, not to a bad-address error.
    const blob = JSON.stringify(json?.error || '').toLowerCase();
    const keyProblem = /api[ _]?key not valid|api_key_invalid|api[ _]?key expired|api_key_expired|keyinvalid|keyexpired/.test(blob);
    const code = res.status === 401 || res.status === 403
      || gStatus === 'PERMISSION_DENIED' || gStatus === 'UNAUTHENTICATED' || keyProblem
      ? 'AUTH'
      : res.status === 400 || gStatus === 'INVALID_ARGUMENT'
        ? 'INSUFFICIENT_INPUT'
        : res.status === 429 || gStatus === 'RESOURCE_EXHAUSTED'
          ? 'UPSTREAM'
          : res.status === 404
            ? 'NOT_FOUND'
            : 'UPSTREAM';
    throw new AddressValidationError(`Google: ${detail}`, code);
  }

  const result = json?.result;
  if (!result) {
    throw new AddressValidationError('Google returned no validation result.', 'UPSTREAM');
  }

  const verdict = result.verdict || {};
  const address = result.address || {};
  const postal = address.postalAddress || {};
  const usps = result.uspsData?.standardizedAddress || {};
  const dpv = s(result.uspsData?.dpvConfirmation).toUpperCase();

  const { line1: outLine1, line2: outLine2, city, state, zip5, zip4 } = composeLines(usps, postal);

  // A usable result must carry a street line, city, state and ZIP5.
  if (!outLine1 || !city || !state || !zip5) {
    throw new AddressValidationError('Google could not resolve this address to a complete mailing address.', 'NOT_FOUND');
  }

  const granularity = s(verdict.validationGranularity).toUpperCase();
  // Granularity coarser than a route (OTHER) means Google could not place the address.
  if (granularity === 'OTHER' || granularity === '') {
    throw new AddressValidationError('Google could not find this address.', 'NOT_FOUND');
  }
  // USPS DPV "N" = not a confirmed deliverable address.
  if (dpv === 'N') {
    throw new AddressValidationError('Google/USPS could not confirm this address is deliverable.', 'UNCONFIRMED');
  }

  const hasUnconfirmed = !!verdict.hasUnconfirmedComponents;
  const hasInferred = !!verdict.hasInferredComponents;
  const hasReplaced = !!verdict.hasReplacedComponents;
  const addressComplete = !!verdict.addressComplete;
  const hasZip4 = !!zip4;

  // Deliverability gate. Google's API is deliberately lenient — it will "standardize"
  // a fabricated address (e.g. "99999 Nowhere Rd") and merely flag
  // hasUnconfirmedComponents, so a non-empty result is NOT proof the address is real.
  // Accept only when there is a positive confirmation signal:
  //   • USPS DPV confirms it (Y / S / D), OR
  //   • Google itself confirms it — complete, no unconfirmed components, resolved to a
  //     premise/sub-premise (some valid new addresses aren't in USPS CASS yet).
  const dpvConfirmed = dpv === 'Y' || dpv === 'S' || dpv === 'D';
  const googleConfirmed = addressComplete && !hasUnconfirmed
    && (granularity === 'PREMISE' || granularity === 'SUB_PREMISE');
  if (!dpvConfirmed && !googleConfirmed) {
    throw new AddressValidationError(
      'Google could not confirm this is a real, deliverable address (unconfirmed components).',
      'NOT_FOUND',
    );
  }

  const v = buildVerdict({ dpv, granularity, addressComplete, hasUnconfirmed, hasInferred, hasZip4 });
  const exact = addressComplete && !hasUnconfirmed && !hasInferred && !hasReplaced
    && (granularity === 'PREMISE' || granularity === 'SUB_PREMISE');

  const formatted = s(address.formattedAddress) || `${outLine1}, ${outLine2}`;

  return {
    line1: outLine1,
    line2: outLine2,
    formatted,
    complete: v.complete,
    hasUnconfirmed,
    hasInferred,
    verdictText: v.text,
    provider: 'google',
    dpv: dpv || null,
    zipPlus4: hasZip4,
    exactMatch: exact,
  };
}

/**
 * Real-time status descriptor for the client popup, sourced from ground truth. The
 * Google Address Validation API is a paid Google Cloud SKU (with a monthly free
 * allowance), so — unlike the previous USPS integration — this does NOT claim to be
 * free of charge.
 */
export function buildGoogleAvStatus(validated = null) {
  return {
    provider: 'Google Address Validation API',
    live: true,
    plan: 'paid',
    planLabel: 'Google Address Validation (billable SKU)',
    verdict: 'LIVE',
    note: 'Validated by the Google Cloud Address Validation API (with USPS CASS) — the sole address validator.',
    dpv: validated?.dpv || null,
    zipPlus4: validated?.zipPlus4 ?? null,
    checkedAt: new Date().toISOString(),
  };
}

/* ----------------------------------------------------------------- health */

let _health = { at: 0, healthy: false, reason: null };
const HEALTH_TTL_OK_MS = 5 * 60 * 1000;   // trust a healthy result for 5 minutes
const HEALTH_TTL_FAIL_MS = 30 * 1000;     // re-check a failure quickly (don't show a stale error)

/**
 * Live Google Address Validation health probe (cached briefly) so the client pill
 * reflects whether the API is ACTUALLY serving right now. Validates a stable,
 * deliverable address. A healthy result is cached for 5 min; a failure is cached only
 * 30s so a transient blip (a momentary network/quota hiccup) doesn't leave a stale
 * "error" on the pill for long.
 */
export async function probeGoogleAvHealth({ force = false } = {}) {
  if (!isGoogleAvConfigured()) {
    return { configured: false, healthy: false, reason: 'Google Address Validation is not configured.' };
  }
  const now = Date.now();
  const ttl = _health.healthy ? HEALTH_TTL_OK_MS : HEALTH_TTL_FAIL_MS;
  if (!force && _health.at && now - _health.at < ttl) {
    return { configured: true, healthy: _health.healthy, reason: _health.reason, cached: true, checkedAt: new Date(_health.at).toISOString() };
  }
  try {
    await validateAddressGoogle({ line1: '1600 Amphitheatre Pkwy', line2: 'Mountain View, CA 94043' }, { timeoutMs: 6000 });
    _health = { at: now, healthy: true, reason: null };
  } catch (err) {
    _health = { at: now, healthy: false, reason: `${err.code || 'ERROR'}: ${err.message}` };
  }
  return { configured: true, healthy: _health.healthy, reason: _health.reason, cached: false, checkedAt: new Date(now).toISOString() };
}
