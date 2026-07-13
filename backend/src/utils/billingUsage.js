import { GoogleAuth } from 'google-auth-library';
import { env } from '../config/env.js';

/**
 * Live Google Cloud usage + SKU reporting for the Address Validation API.
 *
 * Accuracy contract — every number here is sourced from Google, never invented:
 *   • Month-to-date call volume  → Cloud Monitoring API (serviceruntime request_count
 *     for addressvalidation.googleapis.com). This is the REAL number of calls made.
 *   • SKU name, free threshold, unit price → Cloud Billing Catalog API (the SKU's
 *     tiered pricing; the first tier whose unit price is 0 defines the free allowance).
 *
 * When a source is unavailable we report that honestly (verdict 'UNKNOWN') rather
 * than guess. The free threshold is only stated when it comes from the catalog or an
 * explicit operator override — never hardcoded.
 */

const MONITORING_SCOPE = 'https://www.googleapis.com/auth/monitoring.read';
const REQUEST_COUNT_METRIC = 'serviceruntime.googleapis.com/api/request_count';
const ADDRESS_VALIDATION_SERVICE = 'addressvalidation.googleapis.com';
const FETCH_TIMEOUT_MS = 8000;

/** True when enough is configured to read live usage from Cloud Monitoring. */
export function isUsageMonitoringConfigured() {
  const hasProject = !!env.google.gcpProjectId;
  const hasCreds = !!env.google.serviceAccountJson || !!process.env.GOOGLE_APPLICATION_CREDENTIALS;
  return hasProject && hasCreds;
}

/** Bounded fetch that never hangs a request thread. */
async function timedFetch(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Start of the current Google billing month (America/Los_Angeles) as a Date. */
function billingMonthStart(now = new Date()) {
  // Google Cloud billing resets on the 1st at midnight Pacific. Derive that instant
  // from the current Pacific wall-clock date so the free-tier window is accurate.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(now).reduce((a, p) => (a[p.type] = p.value, a), {});
  // Pacific offset for this instant (minutes east of UTC, negative for PST/PDT).
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offsetMs = asUTC - now.getTime();
  // Midnight Pacific on day 1 of the current Pacific month, converted back to UTC.
  const monthStartUTCWall = Date.UTC(+parts.year, +parts.month - 1, 1, 0, 0, 0);
  return new Date(monthStartUTCWall - offsetMs);
}

/** OAuth bearer token for a service account (inline JSON or ADC key-file). */
async function getAccessToken() {
  const opts = { scopes: [MONITORING_SCOPE] };
  if (env.google.serviceAccountJson) {
    opts.credentials = JSON.parse(env.google.serviceAccountJson);
  }
  const auth = new GoogleAuth(opts);
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('Could not obtain a Google access token from the service account.');
  return token;
}

/**
 * Sum every Address Validation API request this billing month from Cloud Monitoring.
 * request_count is a DELTA metric; we align to daily sums and total the points.
 */
async function getMonthToDateCalls() {
  const token = await getAccessToken();
  const project = env.google.gcpProjectId;
  const start = billingMonthStart();
  const end = new Date();

  const filter =
    `metric.type="${REQUEST_COUNT_METRIC}" ` +
    `AND resource.labels.service="${ADDRESS_VALIDATION_SERVICE}"`;

  const params = new URLSearchParams({
    filter,
    'interval.startTime': start.toISOString(),
    'interval.endTime': end.toISOString(),
    'aggregation.alignmentPeriod': '86400s',
    'aggregation.perSeriesAligner': 'ALIGN_SUM',
    'aggregation.crossSeriesReducer': 'REDUCE_SUM',
    view: 'FULL',
  });

  const url = `https://monitoring.googleapis.com/v3/projects/${encodeURIComponent(project)}/timeSeries?${params}`;
  const res = await timedFetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = payload?.error?.message || `Cloud Monitoring returned HTTP ${res.status}.`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }

  let total = 0;
  for (const series of payload?.timeSeries || []) {
    for (const point of series.points || []) {
      const v = point.value || {};
      total += Number(v.int64Value ?? v.doubleValue ?? 0);
    }
  }
  return { calls: total, periodStart: start.toISOString(), periodEnd: end.toISOString() };
}

/** A numeric price from a Billing Catalog tieredRate ({units, nanos}). */
function rateToNumber(rate) {
  if (!rate) return null;
  const units = Number(rate.units || 0);
  const nanos = Number(rate.nanos || 0);
  return units + nanos / 1e9;
}

/**
 * Resolve the Address Validation SKU's free monthly allowance + unit price from the
 * Cloud Billing Catalog. Returns null fields when the catalog is unavailable so the
 * caller can report 'unknown' rather than fabricate. Uses the Address Validation
 * API key (Catalog reads support API-key auth).
 */
export async function getSkuPricing() {
  if (!env.google.billingCatalogEnabled) return { available: false, reason: 'disabled' };
  const key = env.google.addressValidationKey;
  if (!key) return { available: false, reason: 'no_key' };

  // 1) Find the dedicated "Address Validation API" billing service (not the other
  //    Google Maps Platform services, which have their own SKUs).
  const svcRes = await timedFetch(
    `https://cloudbilling.googleapis.com/v1/services?key=${encodeURIComponent(key)}&pageSize=2000`
  );
  const svcJson = await svcRes.json().catch(() => null);
  if (!svcRes.ok) {
    return { available: false, reason: svcJson?.error?.status || `http_${svcRes.status}`, message: svcJson?.error?.message };
  }
  const services = svcJson?.services || [];
  const avSvc = services.find((s) => /^address\s*validation/i.test(s.displayName || ''))
    || services.find((s) => /address\s*validation/i.test(s.displayName || ''));
  if (!avSvc) return { available: false, reason: 'address_validation_service_not_found' };

  // 2) Page the service's SKUs and collect the Address Validation editions. Our calls
  //    use USPS CASS (enableUspsCass), which bills under the ENTERPRISE edition; a
  //    non-CASS call bills under PRO. Select the edition that matches our request.
  const wantEnterprise = env.google.usesUspsCass;
  let pageToken = '';
  const skus = [];
  for (let i = 0; i < 20; i += 1) { // hard page cap
    const url = `https://cloudbilling.googleapis.com/v1/${avSvc.name}/skus?key=${encodeURIComponent(key)}&pageSize=500` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
    const skuRes = await timedFetch(url);
    const skuJson = await skuRes.json().catch(() => null);
    if (!skuRes.ok) return { available: false, reason: skuJson?.error?.status || `http_${skuRes.status}` };
    for (const sku of skuJson?.skus || []) {
      if (/address\s*validation/i.test(String(sku.description || ''))) skus.push(sku);
    }
    pageToken = skuJson?.nextPageToken || '';
    if (!pageToken) break;
  }
  if (!skus.length) return { available: false, reason: 'address_validation_sku_not_found' };

  const byEdition = (re) => skus.find((s) => re.test(String(s.description || '')));
  const best = wantEnterprise
    ? (byEdition(/enterprise/i) || byEdition(/pro/i) || skus[0])
    : (byEdition(/\bpro\b/i) || byEdition(/essentials/i) || byEdition(/enterprise/i) || skus[0]);

  const pricing = (best.pricingInfo || [])[0]?.pricingExpression || {};
  const tiers = pricing.tieredRates || [];
  const usageUnit = pricing.usageUnit || pricing.displayQuantity || 'count';
  // Free allowance = start of the first tier whose unit price is > 0. A leading
  // $0 tier means Google gives that many units free each month before charging.
  let freeUnits = null;
  let paidUnitPrice = null;
  let currency = 'USD';
  for (const t of tiers) {
    const price = rateToNumber(t.unitPrice);
    currency = t.unitPrice?.currencyCode || currency;
    if (price && price > 0) { freeUnits = Number(t.startUsageAmount || 0); paidUnitPrice = price; break; }
  }
  return {
    available: true,
    serviceName: avSvc.displayName,
    skuId: best.skuId,
    skuName: best.description,
    edition: wantEnterprise ? 'Enterprise (USPS CASS)' : 'Pro',
    usageUnit,
    freeUnits,                    // may be 0 (no free tier) — distinct from null (unknown)
    unitPrice: paidUnitPrice,
    currency,
  };
}

/**
 * Full, accurate live status for the Address Validation API's free-tier / SKU usage.
 * Combines real month-to-date call volume with the SKU's catalog pricing. Never
 * fabricates: any figure it cannot source is returned as null with an honest verdict.
 *
 * @returns {Promise<object>} status descriptor for the client popup.
 */
export async function getAddressValidationUsage({ appCalls = null } = {}) {
  const base = {
    provider: 'Google Address Validation API',
    usesUspsCass: env.google.usesUspsCass,
    checkedAt: new Date().toISOString(),
  };

  const monitoringConfigured = isUsageMonitoringConfigured();

  // SKU pricing (Billing Catalog, API-key auth) is independent of usage monitoring,
  // so fetch it regardless. Project-wide month-to-date volume needs the service
  // account, so only fetch it when monitoring is configured. Either may fail alone.
  const [pricingR, usageR] = await Promise.allSettled([
    getSkuPricing(),
    monitoringConfigured ? getMonthToDateCalls() : Promise.resolve(null),
  ]);

  const pricing = pricingR.status === 'fulfilled'
    ? pricingR.value
    : { available: false, reason: pricingR.reason?.message || 'error' };
  const monitorUsage = usageR.status === 'fulfilled' ? usageR.value : null;
  const usageError = usageR.status === 'rejected' ? (usageR.reason?.message || String(usageR.reason)) : null;

  // Free threshold: Billing Catalog first, then an explicit operator override. Never hardcoded.
  const overrideFree = env.google.addressValidationFreeMonthly > 0 ? env.google.addressValidationFreeMonthly : null;
  const freeMonthly = (pricing.available && pricing.freeUnits != null && pricing.freeUnits > 0)
    ? pricing.freeUnits
    : overrideFree;

  // Call volume source of truth: Cloud Monitoring (project-wide) when available,
  // else the app's own self-hosted counter (this app's calls). Both are real; the
  // app counter needs no service account and uses only the existing API key.
  let callsThisMonth = null;
  let usageSource = null;
  let periodStart = null;
  if (monitorUsage) {
    callsThisMonth = monitorUsage.calls;
    usageSource = 'cloud_monitoring';
    periodStart = monitorUsage.periodStart;
  } else if (appCalls != null) {
    callsThisMonth = appCalls;
    usageSource = 'app_counter';
  }

  let verdict = 'UNKNOWN';
  let withinFreeTier = null;
  let remainingFree = null;
  // A FREE/PAYMENT verdict requires BOTH a real call count and a known free threshold.
  if (freeMonthly != null && callsThisMonth != null) {
    withinFreeTier = callsThisMonth < freeMonthly;
    remainingFree = Math.max(0, freeMonthly - callsThisMonth);
    verdict = withinFreeTier ? 'FREE' : 'PAYMENT';
  }

  // Honest explanation of the verdict basis / any gap.
  let reason;
  if (usageSource === 'app_counter') {
    reason = 'Call volume is counted by this application (no service account needed). If the API key is shared with other apps, project-wide usage may be higher; enable Cloud Monitoring for the project-wide total.';
  }
  if (verdict === 'UNKNOWN') {
    if (usageError) {
      reason = `Could not read live usage from Cloud Monitoring: ${usageError}`;
    } else if (callsThisMonth == null) {
      reason = 'No call-volume source available yet (make a validation, or configure Cloud Monitoring). Showing live SKU pricing only.';
    } else if (freeMonthly == null) {
      reason = pricing.available
        ? 'This SKU has no free-tier threshold in the Billing Catalog.'
        : `Billing Catalog unavailable (${pricing.reason || 'unknown'}).`;
    }
  }

  return {
    ...base,
    configured: monitoringConfigured || appCalls != null, // a usage source is available
    live: true,
    verdict,                                    // FREE | PAYMENT | UNKNOWN
    withinFreeTier,
    callsThisMonth,
    freeMonthly,                                // null when the threshold is unknown
    remainingFree,
    periodStart,
    sku: pricing.available ? {
      id: pricing.skuId,
      name: pricing.skuName,
      edition: pricing.edition,
      unitPrice: pricing.unitPrice,
      currency: pricing.currency,
      usageUnit: pricing.usageUnit,
    } : null,
    pricingSource: pricing.available ? 'billing_catalog' : (overrideFree ? 'operator_override' : 'unavailable'),
    usageSource,
    reason,
  };
}
