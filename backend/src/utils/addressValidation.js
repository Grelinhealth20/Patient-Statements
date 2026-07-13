import { env } from '../config/env.js';

/**
 * Thin, enterprise-grade client for the Google Address Validation API.
 *
 *   POST https://addressvalidation.googleapis.com/v1:validateAddress
 *
 * The API key lives only on the server (env.google.addressValidationKey) and is
 * never exposed to the browser. Every call is bounded by an abort-controller
 * timeout so a slow/hung upstream can never tie up a request thread.
 */

const ENDPOINT = 'https://addressvalidation.googleapis.com/v1:validateAddress';
const DEFAULT_TIMEOUT_MS = 10000;

const s = (v) => (v == null ? '' : String(v)).trim();

/** A structured error carrying an HTTP status so the controller can map it cleanly. */
export class AddressValidationError extends Error {
  constructor(message, status = 502, code = '') {
    super(message);
    this.name = 'AddressValidationError';
    this.status = status;
    this.code = code; // machine-readable cause, e.g. 'BILLING_DISABLED', 'NOT_CONFIGURED'
  }
}

/**
 * Derive the live API billing/plan status accurately from a real call result.
 * Google's Address Validation response exposes NO per-call billing/tier field, so
 * we infer from ground truth: any successful Maps Platform call requires an enabled
 * billing account (calls without billing are rejected with 403 PERMISSION_DENIED).
 * Therefore success ⇒ billing is enabled (pay-as-you-go). Whether a given call fell
 * within Google's recurring free monthly usage credit is an account-level aggregate
 * Google does not return, so it is never fabricated here.
 *
 * @param {'ok'|'billing_disabled'} state
 * @param {string} [responseId]  Google responseId of the underlying call.
 * @returns {object} Accurate, real-time API-mode descriptor for the client popup.
 */
export function buildApiStatus(state, responseId = '') {
  if (state === 'billing_disabled') {
    return {
      provider: 'Google Address Validation API',
      live: true,
      billingEnabled: false,
      plan: 'no_billing',
      planLabel: 'Free tier / no billing',
      verdict: 'FREE',
      note: 'Billing is not enabled on this API key. Address Validation is a Google Maps Platform API and cannot run without an active billing account.',
      responseId: responseId || null,
      checkedAt: new Date().toISOString(),
    };
  }
  return {
    provider: 'Google Address Validation API',
    live: true,
    billingEnabled: true,
    plan: 'pay_as_you_go',
    planLabel: 'Payment · Billing-enabled (Pay-as-you-go)',
    verdict: 'PAYMENT',
    note: 'Served by a billing-enabled Google Cloud project. Google applies a recurring free monthly usage credit before any charge; the per-call free-vs-charged split is not exposed by Google.',
    responseId: responseId || null,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Validate a US-style address given free-form lines.
 * @param {string[]} addressLines  Non-empty address lines (street, city/state/zip…).
 * @param {object}   [opts]
 * @param {string}   [opts.regionCode]  ISO region (default env.google.addressRegion, "US").
 * @param {number}   [opts.timeoutMs]
 * @returns {Promise<object>} Raw Google ValidationResult payload ({ result, responseId }).
 */
export async function validateAddress(addressLines, opts = {}) {
  const key = env.google.addressValidationKey;
  if (!key) {
    throw new AddressValidationError('Address validation is not configured on the server.', 503, 'NOT_CONFIGURED');
  }

  const lines = (addressLines || []).map(s).filter(Boolean);
  if (!lines.length) {
    throw new AddressValidationError('No address to validate.', 400);
  }
  // Google caps the combined input at 280 characters.
  if (lines.join(' ').length > 280) {
    throw new AddressValidationError('Address is too long to validate (max 280 characters).', 400);
  }

  const body = {
    address: {
      regionCode: opts.regionCode || env.google.addressRegion || 'US',
      addressLines: lines,
    },
    enableUspsCass: true,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${ENDPOINT}?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new AddressValidationError('Address validation timed out. Please try again.', 504);
    }
    throw new AddressValidationError(`Could not reach the address validation service: ${err.message}`, 502);
  } finally {
    clearTimeout(timer);
  }

  let payload;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (!res.ok) {
    const gErr = payload?.error || {};
    const msg = gErr.message || `Address validation failed (HTTP ${res.status}).`;
    // A disabled billing account surfaces as 403 PERMISSION_DENIED / a "billing"
    // message — flag it so the client popup can report the free/no-billing state.
    const isBilling = res.status === 403 &&
      (gErr.status === 'PERMISSION_DENIED' || /billing/i.test(msg));
    // 4xx from Google is a bad request on our side; map to 422 so the client shows it.
    const httpStatus = res.status >= 400 && res.status < 500 ? 422 : 502;
    throw new AddressValidationError(msg, isBilling ? 402 : httpStatus, isBilling ? 'BILLING_DISABLED' : '');
  }
  return payload || {};
}

/**
 * Reduce a Google ValidationResult into the two-line address the app stores, plus
 * a human-readable verdict. Prefers USPS-standardized (CASS) fields for US mail,
 * falling back to the componentized postalAddress.
 *
 * @returns {{ line1: string, line2: string, formatted: string,
 *             complete: boolean, verdictText: string }}
 */
export function extractValidatedAddress(payload) {
  const result = payload?.result || {};
  const verdict = result.verdict || {};
  const address = result.address || {};
  const postal = address.postalAddress || {};
  const usps = result.uspsData || {};
  const std = usps.standardizedAddress || {};

  // Compose a full ZIP+4 ("19075-1541") from the 5-digit ZIP and its add-on. The
  // USPS +4 arrives in a separate field (`zipCodeExtension`); when it is absent we
  // keep the 5-digit ZIP rather than emit a dangling hyphen. Also tolerates a ZIP
  // that already carries the +4 inline (e.g. from Google's postalCode).
  const joinZip = (zip, ext) => {
    const z = s(zip);
    const e = s(ext);
    if (!z) return '';
    if (z.includes('-')) return z;            // already ZIP+4
    return e ? `${z}-${e}` : z;
  };
  const cityStateZip = (city, state, zip) =>
    [s(city), [s(state), s(zip)].filter(Boolean).join(' ')].filter(Boolean).join(', ');

  let line1 = '';
  let line2 = '';

  if (std.firstAddressLine) {
    // USPS CASS standardized form (best for US delivery points). Build the
    // city/state/ZIP+4 line from components so the +4 is always included, rather
    // than trusting cityStateZipAddressLine (which may carry only the 5-digit ZIP).
    line1 = [s(std.firstAddressLine), s(std.secondAddressLine)].filter(Boolean).join(', ');
    const zip = joinZip(std.zipCode, std.zipCodeExtension);
    line2 = cityStateZip(std.city, std.state, zip)
      || s(std.cityStateZipAddressLine);
  } else {
    // Componentized postal address fallback. Google's postalCode is already the
    // full ZIP+4 when USPS CASS resolved it, so it is used verbatim.
    const addrLines = (postal.addressLines || []).map(s).filter(Boolean);
    line1 = addrLines[0] || '';
    const csz = cityStateZip(postal.locality, postal.administrativeArea, joinZip(postal.postalCode));
    // Any additional street lines (e.g. suite) fold into line2 ahead of city/state/zip.
    line2 = [addrLines.slice(1).join(', '), csz].filter(Boolean).join(', ');
  }

  const formatted = s(address.formattedAddress) || [line1, line2].filter(Boolean).join(', ');
  const granularity = s(verdict.validationGranularity) || 'UNKNOWN';
  const verdictText = verdict.addressComplete
    ? `Confirmed (${granularity.toLowerCase()})`
    : `Needs review (${granularity.toLowerCase()})`;

  return {
    line1,
    line2,
    formatted,
    complete: !!verdict.addressComplete,
    hasUnconfirmed: !!verdict.hasUnconfirmedComponents,
    hasInferred: !!verdict.hasInferredComponents,
    verdictText,
  };
}
