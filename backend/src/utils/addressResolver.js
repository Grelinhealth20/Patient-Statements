import {
  validateAddressUspsV3,
  isUspsV3Configured,
  buildUspsV3Status,
  probeUspsV3Health,
  UspsValidationError,
} from './uspsApiV3.js';

/**
 * Address validation is served EXCLUSIVELY by the USPS Addresses v3 API — the single,
 * sole validator for the whole app. No other address-validation API is used.
 *
 * When USPS cannot identify an address, the `UspsValidationError` is propagated to the
 * caller so the user gets an accurate message — nothing is silently substituted.
 */

/** True when the USPS Addresses v3 API is configured (Consumer Key + Secret present). */
export function isAnyUspsConfigured() {
  return isUspsV3Configured();
}

/**
 * Live USPS health so the status endpoint reflects what USPS is ACTUALLY doing right
 * now, never a fabricated state.
 */
export async function probeUsps(opts) {
  return { path: 'v3', ...(await probeUspsV3Health(opts)) };
}

/**
 * Resolve a patient's mailing address to its USPS-standardized form, real-time.
 *
 * @param {{line1?: string, line2?: string}} input
 * @returns {Promise<{validated: object, provider: 'usps', apiStatus: object}>}
 * @throws {UspsValidationError} when USPS cannot identify the address (or is unconfigured).
 */
export async function resolvePatientAddress({ line1, line2 } = {}) {
  const validated = await validateAddressUspsV3({ line1, line2 });
  return { validated, provider: 'usps', apiStatus: buildUspsV3Status(validated) };
}

export { UspsValidationError };
