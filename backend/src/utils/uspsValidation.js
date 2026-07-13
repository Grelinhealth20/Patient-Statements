import { env } from '../config/env.js';

/**
 * Primary address validator: the USPS Web Tools Address Validation API.
 *
 *   GET https://secure.shippingapis.com/ShippingAPI.dll?API=Verify&XML=<AddressValidateRequest…>
 *
 * Authentication is the account USERID only (no password is ever sent). USPS is the
 * source of truth for US mail: it standardizes the delivery line, appends the ZIP+4,
 * and returns a DPV (Delivery Point Validation) verdict. Every call is bounded by an
 * abort-controller timeout so a slow/hung upstream can never tie up a request thread.
 *
 * `validateAddressUSPS()` (legacy Web Tools path) returns a normalized shape
 * (line1/line2/formatted/complete/verdictText…) so the controller and DB-update path
 * are provider-agnostic. When USPS cannot identify an address accurately it throws
 * `UspsValidationError`, which the caller surfaces to the user. USPS is the sole
 * validator — there is no fallback provider.
 */

const DEFAULT_TIMEOUT_MS = 10000;

const s = (v) => (v == null ? '' : String(v)).trim();

/** Structured error signalling that USPS could not accurately validate the address. */
export class UspsValidationError extends Error {
  constructor(message, code = '') {
    super(message);
    this.name = 'UspsValidationError';
    this.code = code; // NOT_CONFIGURED | INSUFFICIENT_INPUT | AUTH | NOT_FOUND | UNCONFIRMED | UPSTREAM | TIMEOUT
  }
}

/** True when USPS Web Tools is configured (a USERID is present). */
export function isUspsConfigured() {
  return !!env.usps.userId;
}

/** XML-escape a value so it is safe inside the request document. */
function xmlEscape(v) {
  return s(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Inner text of the first <tag>…</tag> within `xml` (case-insensitive), or ''. */
function tag(xml, name) {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return m ? m[1].trim() : '';
}

/** Parse a free-form "City, ST 12345-6789" tail into components (zip optional). */
function parseCityStateZip(line) {
  const t = s(line);
  if (!t) return { city: '', state: '', zip5: '', zip4: '' };
  // City [,] ST ZIP[-4]
  let m = t.match(/^\s*(.+?)[,\s]+([A-Za-z]{2})\s+(\d{5})(?:-(\d{4}))?\s*$/);
  if (m) return { city: m[1].replace(/[,\s]+$/, '').trim(), state: m[2].toUpperCase(), zip5: m[3], zip4: m[4] || '' };
  // City [,] ST  (no ZIP — USPS can infer it)
  m = t.match(/^\s*(.+?)[,\s]+([A-Za-z]{2})\s*$/);
  if (m) return { city: m[1].replace(/[,\s]+$/, '').trim(), state: m[2].toUpperCase(), zip5: '', zip4: '' };
  return { city: '', state: '', zip5: '', zip4: '' };
}

/**
 * Pull a trailing secondary unit (APT/STE/UNIT/#/BLDG/FL/RM…) off a street line.
 * Returns { primary, secondary } — secondary is '' when none is present.
 *
 * Conservative by design: it only splits when a recognized unit designator is
 * followed by an identifier that is clearly a unit — one containing a digit
 * ("STE 100", "# 410253", "APT 4B") or a lone letter ("UNIT B"). This avoids
 * mis-splitting real street names that merely contain a designator word
 * (e.g. "100 SPACE CENTER BLVD", "5 LOT LANE").
 */
function splitSecondary(street) {
  const t = s(street);
  const unitId = '(?:[\\w-]*\\d[\\w-]*|[A-Za-z])'; // has a digit, or a single letter
  const desig = '(?:#|apt|apartment|ste|suite|unit|bldg|building|fl|floor|rm|room|dept|department|space|spc|trlr|lot|pmb|box|hangar|slip|pier|key|stop)';
  const re = new RegExp(`^(.*?\\S)[,\\s]+(${desig}\\.?\\s*#?\\s*${unitId})\\s*$`, 'i');
  const m = t.match(re);
  // Require the primary remainder to still contain a street number + name.
  if (m && /\d/.test(m[1]) && /[a-z]/i.test(m[1])) {
    return { primary: m[1].replace(/[,\s]+$/, '').trim(), secondary: m[2].replace(/\s+/g, ' ').trim() };
  }
  return { primary: t, secondary: '' };
}

/**
 * Split the app's two free-form lines into the components USPS needs:
 *   street (primary delivery line) + secondary (unit) + city + state + zip5[/zip4].
 * Handles the clean two-line case (line1=street, line2="City, ST ZIP") and the
 * combined case (everything on line1). Exported so both the legacy Web Tools client
 * and the USPS APIs v3 client parse input identically.
 */
export function splitAddress(line1, line2) {
  const l1 = s(line1);
  const l2 = s(line2);

  // Preferred: street on line1, city/state/zip on line2.
  let csz = parseCityStateZip(l2);
  if (csz.zip5 || csz.state) {
    const { primary, secondary } = splitSecondary(l1);
    return { street: primary, secondary, ...csz };
  }

  // Fallback: city/state/zip is embedded at the end of the combined text.
  const combined = [l1, l2].filter(Boolean).join(', ');
  csz = parseCityStateZip(combined);
  if (csz.zip5 || csz.state) {
    const anchor = csz.city ? combined.toLowerCase().lastIndexOf(csz.city.toLowerCase()) : -1;
    const streetRaw = anchor > 0 ? combined.slice(0, anchor).replace(/[,\s]+$/, '') : l1;
    const { primary, secondary } = splitSecondary(streetRaw || l1);
    return { street: primary || l1, secondary, ...csz };
  }

  // Nothing parseable — return the raw street so the caller can decide.
  const { primary, secondary } = splitSecondary(l1);
  return { street: primary, secondary, city: '', state: '', zip5: '', zip4: '' };
}

/** USPS DPV → human verdict. Y/S/D = deliverable (confirmed); N = not confirmed. */
function dpvVerdict(dpv, hasZip4) {
  const c = s(dpv).toUpperCase();
  if (c === 'Y') return { complete: true, text: 'Confirmed (USPS DPV)' };
  if (c === 'S') return { complete: true, text: 'Confirmed (USPS DPV — secondary unneeded)' };
  if (c === 'D') return { complete: false, text: 'Confirmed street (USPS DPV — secondary missing)' };
  if (c === 'N') return { complete: false, text: 'Not confirmed (USPS DPV)' };
  // No DPV field returned (account without DPV): trust a full ZIP+4 as confirmation.
  return { complete: hasZip4, text: hasZip4 ? 'Standardized (USPS, ZIP+4)' : 'Standardized (USPS)' };
}

/**
 * Validate a patient's address with USPS. Returns the normalized standardized
 * address on success, or throws `UspsValidationError` when USPS cannot accurately
 * identify it (the caller surfaces the message; there is no fallback provider).
 *
 * @param {{line1?: string, line2?: string}} input  The app's two address lines.
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 */
export async function validateAddressUSPS({ line1, line2 } = {}, opts = {}) {
  const userId = env.usps.userId;
  if (!userId) throw new UspsValidationError('USPS is not configured on the server.', 'NOT_CONFIGURED');

  const { street, secondary, city, state, zip5, zip4 } = splitAddress(line1, line2);
  // USPS requires the delivery line plus EITHER a ZIP5 OR a City+State.
  if (!street || (!zip5 && !(city && state))) {
    throw new UspsValidationError('Not enough address detail for USPS to validate.', 'INSUFFICIENT_INPUT');
  }

  // USPS quirk: <Address1> is the secondary unit (apt/suite), <Address2> is the
  // primary street. USPS still returns them separated, which we recombine below.
  const requestXml =
    `<AddressValidateRequest USERID="${xmlEscape(userId)}">` +
    `<Revision>1</Revision>` +
    `<Address ID="0">` +
    `<Address1>${xmlEscape(secondary)}</Address1>` +
    `<Address2>${xmlEscape(street)}</Address2>` +
    `<City>${xmlEscape(city)}</City>` +
    `<State>${xmlEscape(state)}</State>` +
    `<Zip5>${xmlEscape(zip5)}</Zip5>` +
    `<Zip4>${xmlEscape(zip4)}</Zip4>` +
    `</Address>` +
    `</AddressValidateRequest>`;

  const url = `${env.usps.endpoint}?API=Verify&XML=${encodeURIComponent(requestXml)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  let text;
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    text = await res.text();
    if (!res.ok) {
      throw new UspsValidationError(`USPS responded HTTP ${res.status}.`, 'UPSTREAM');
    }
  } catch (err) {
    if (err instanceof UspsValidationError) throw err;
    if (err.name === 'AbortError') throw new UspsValidationError('USPS validation timed out.', 'TIMEOUT');
    throw new UspsValidationError(`Could not reach USPS: ${err.message}`, 'UPSTREAM');
  } finally {
    clearTimeout(timer);
  }

  // Top-level <Error> (outside <Address>) = request-level failure (bad USERID, the
  // Address APIs not activated for this account, service down, malformed request).
  if (!/<AddressValidateResponse/i.test(text) && /<Error>/i.test(text)) {
    const desc = tag(text, 'Description') || 'USPS request failed.';
    throw new UspsValidationError(`USPS: ${desc}`, 'AUTH');
  }

  // Isolate the returned <Address> block.
  const block = (text.match(/<Address\b[^>]*>([\s\S]*?)<\/Address>/i) || [])[1] || '';
  if (!block) throw new UspsValidationError('USPS returned no address.', 'UPSTREAM');

  // Per-address <Error> = USPS could not identify this specific address.
  if (/<Error>/i.test(block)) {
    const desc = tag(block, 'Description') || 'Address Not Found.';
    throw new UspsValidationError(`USPS: ${desc}`, 'NOT_FOUND');
  }

  const outStreet = tag(block, 'Address2'); // standardized primary street
  const outSecondary = tag(block, 'Address1'); // standardized secondary (suite/apt)
  const outCity = tag(block, 'City');
  const outState = tag(block, 'State');
  const outZip5 = tag(block, 'Zip5');
  const outZip4 = tag(block, 'Zip4');
  const dpv = tag(block, 'DPVConfirmation');

  // A usable result must carry a standardized street, city, state, and ZIP5.
  if (!outStreet || !outCity || !outState || !outZip5) {
    throw new UspsValidationError('USPS returned an incomplete address.', 'NOT_FOUND');
  }
  // A DPV "N" verdict means USPS could not confirm the address is deliverable.
  if (s(dpv).toUpperCase() === 'N') {
    throw new UspsValidationError('USPS could not confirm this address is deliverable.', 'UNCONFIRMED');
  }

  const outLine1 = [outStreet, outSecondary].filter(Boolean).join(' ');
  const zip = outZip4 ? `${outZip5}-${outZip4}` : outZip5;
  const outLine2 = `${outCity}, ${outState} ${zip}`;
  const verdict = dpvVerdict(dpv, !!outZip4);

  return {
    line1: outLine1,
    line2: outLine2,
    formatted: `${outLine1}, ${outLine2}`,
    complete: verdict.complete,
    hasUnconfirmed: false,
    hasInferred: !!outZip4, // ZIP+4 is inferred/appended by USPS
    verdictText: verdict.text,
    provider: 'usps',
    dpv: s(dpv).toUpperCase() || null,
    zipPlus4: !!outZip4,
  };
}

/**
 * Live USPS health probe (cached briefly). Validates USPS's own documented example
 * address so the client pill reflects whether USPS is ACTUALLY serving right now —
 * not merely whether a USERID is present. A configured-but-failing account (e.g. the
 * Address APIs not activated) is reported as unhealthy with the real reason, so the
 * UI shows USPS as unavailable rather than falsely claiming it is serving.
 */
let _health = { at: 0, healthy: false, reason: null };
const HEALTH_TTL_MS = 5 * 60 * 1000;

export async function probeUspsHealth({ force = false } = {}) {
  if (!isUspsConfigured()) return { configured: false, healthy: false, reason: 'USPS is not configured.' };
  const now = Date.now();
  if (!force && _health.at && now - _health.at < HEALTH_TTL_MS) {
    return { configured: true, healthy: _health.healthy, reason: _health.reason, cached: true, checkedAt: new Date(_health.at).toISOString() };
  }
  try {
    // USPS Web Tools' own documented example address — stable and always deliverable
    // whenever the API is actually serving this account.
    await validateAddressUSPS({ line1: '6406 Ivy Lane', line2: 'Greenbelt, MD 20770' }, { timeoutMs: 6000 });
    _health = { at: now, healthy: true, reason: null };
  } catch (err) {
    _health = { at: now, healthy: false, reason: `${err.code || 'ERROR'}: ${err.message}` };
  }
  return { configured: true, healthy: _health.healthy, reason: _health.reason, cached: false, checkedAt: new Date(now).toISOString() };
}

/**
 * Accurate, real-time API-mode descriptor for the client popup when USPS served the
 * validation. USPS Web Tools address validation is free (no per-call billing), so the
 * verdict is always FREE — sourced from ground truth, never fabricated.
 */
export function buildUspsStatus(validated = null, providerLabel = 'USPS Web Tools (Address Validation)') {
  return {
    provider: providerLabel,
    live: true,
    billingEnabled: null, // USPS Web Tools has no per-call billing
    plan: 'free',
    planLabel: 'USPS Web Tools — free (no per-call charge)',
    verdict: 'FREE',
    note: 'Validated by the USPS Address Validation API. USPS address validation is provided free of charge and is the sole validator.',
    dpv: validated?.dpv || null,
    zipPlus4: validated?.zipPlus4 ?? null,
    checkedAt: new Date().toISOString(),
  };
}
