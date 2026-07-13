import { getPool } from '../config/db.js';

/**
 * Self-hosted monthly counter for outbound Google API calls the backend makes.
 *
 * The server is the only caller of the Address Validation API, so counting each
 * billable call here yields an accurate month-to-date volume — enough to decide
 * free-tier vs paid against the SKU's free allowance — WITHOUT Cloud Monitoring or
 * a service account. If the same API key/SKU is shared with other apps this counts
 * only this app's calls (a lower bound); Cloud Monitoring, when configured, takes
 * precedence as the project-wide source of truth.
 */

/** Current Google billing month label "YYYY-MM" in America/Los_Angeles (Google's reset tz). */
export function currentBillingPeriod(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit',
  }).formatToParts(now);
  const y = parts.find((p) => p.type === 'year').value;
  const m = parts.find((p) => p.type === 'month').value;
  return `${y}-${m}`;
}

/** Atomically increment this month's counter for a metric. Never throws to a caller. */
export async function recordApiCall(metric = 'address_validation', n = 1) {
  try {
    const pool = getPool();
    await pool.query(
      `INSERT INTO api_usage_monthly (metric, period, calls)
       VALUES (:metric, :period, :n)
       ON DUPLICATE KEY UPDATE calls = calls + :n`,
      { metric, period: currentBillingPeriod(), n }
    );
  } catch {
    /* usage accounting must never break a validation request */
  }
}

/** Read this month's call count for a metric (0 when none recorded yet). */
export async function getMonthlyCallCount(metric = 'address_validation') {
  const pool = getPool();
  const [[row]] = await pool.query(
    `SELECT calls FROM api_usage_monthly WHERE metric = :metric AND period = :period`,
    { metric, period: currentBillingPeriod() }
  );
  return Number(row?.calls || 0);
}
