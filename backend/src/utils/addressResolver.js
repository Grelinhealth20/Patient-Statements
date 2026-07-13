import {
  validateAddressUSPS,
  isUspsConfigured,
  buildUspsStatus,
  probeUspsHealth,
  UspsValidationError,
} from './uspsValidation.js';
import {
  validateAddressUspsV3,
  isUspsV3Configured,
  buildUspsV3Status,
  probeUspsV3Health,
} from './uspsApiV3.js';

/**
 * Address validation is served EXCLUSIVELY by USPS — the source of truth for US mail.
 * (The former Google Address Validation backup has been removed entirely.)
 *
 *   • USPS APIs v3 (apis.usps.com, OAuth2) is preferred.
 *   • Legacy USPS Web Tools (USERID) is used only if v3 credentials are absent.
 *
 * When USPS cannot identify an address, the `UspsValidationError` is propagated to the
 * caller so the user gets an accurate message — nothing is silently substituted.
 */

/** True when ANY USPS auth path is configured (v3 OAuth or legacy Web Tools USERID). */
export function isAnyUspsConfigured() {
  return isUspsV3Configured() || isUspsConfigured();
}

/**
 * Live USPS health for the active auth path (v3 preferred). Used by the status endpoint
 * so the client pill reflects what USPS is ACTUALLY doing, never a fabricated state.
 */
export async function probeUsps(opts) {
  if (isUspsV3Configured()) return { path: 'v3', ...(await probeUspsV3Health(opts)) };
  if (isUspsConfigured()) return { path: 'webtools', ...(await probeUspsHealth(opts)) };
  return { path: 'none', configured: false, healthy: false, reason: 'USPS is not configured.' };
}

/** Validate via the preferred configured USPS path; throws UspsValidationError on any miss. */
async function validateViaUsps({ line1, line2 }) {
  if (isUspsV3Configured()) {
    const validated = await validateAddressUspsV3({ line1, line2 });
    return { validated, apiStatus: buildUspsV3Status(validated) };
  }
  if (isUspsConfigured()) {
    const validated = await validateAddressUSPS({ line1, line2 });
    return { validated, apiStatus: buildUspsStatus(validated) };
  }
  throw new UspsValidationError('USPS address validation is not configured on the server.', 'NOT_CONFIGURED');
}

/**
 * Resolve a patient's mailing address to its USPS-standardized form, real-time.
 *
 * @param {{line1?: string, line2?: string}} input
 * @returns {Promise<{validated: object, provider: 'usps', apiStatus: object}>}
 * @throws {UspsValidationError} when USPS cannot identify the address (or is unconfigured).
 */
export async function resolvePatientAddress({ line1, line2 } = {}) {
  const { validated, apiStatus } = await validateViaUsps({ line1, line2 });
  return { validated, provider: 'usps', apiStatus };
}
