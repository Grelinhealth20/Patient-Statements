import {
  validateAddressGoogle,
  isGoogleAvConfigured,
  buildGoogleAvStatus,
  probeGoogleAvHealth,
  AddressValidationError,
} from './googleAddressValidation.js';

/**
 * Address validation is served EXCLUSIVELY by the Google Cloud Address Validation API
 * (with USPS CASS) — the single, sole validator for the whole app. No other
 * address-validation API is used.
 *
 * When Google cannot identify an address, the `AddressValidationError` is propagated to
 * the caller so the user gets an accurate message — nothing is silently substituted.
 */

/** True when the address validator (Google Address Validation) is configured. */
export function isAddressValidationConfigured() {
  return isGoogleAvConfigured();
}

/**
 * Live validator health so the status endpoint reflects what Google is ACTUALLY doing
 * right now, never a fabricated state.
 */
export async function probeAddressValidation(opts) {
  return { path: 'google-av', ...(await probeGoogleAvHealth(opts)) };
}

/**
 * Resolve a patient's mailing address to its standardized form, real-time.
 *
 * @param {{line1?: string, line2?: string}} input
 * @returns {Promise<{validated: object, provider: 'google', apiStatus: object}>}
 * @throws {AddressValidationError} when the address can't be identified (or is unconfigured).
 */
export async function resolvePatientAddress({ line1, line2 } = {}) {
  const validated = await validateAddressGoogle({ line1, line2 });
  return { validated, provider: 'google', apiStatus: buildGoogleAvStatus(validated) };
}

export { AddressValidationError };
