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
import { validateAddress, extractValidatedAddress, buildApiStatus } from './addressValidation.js';

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

/** Attempt USPS validation via the preferred configured path; throws UspsValidationError on any miss. */
async function tryUsps({ line1, line2 }) {
  if (isUspsV3Configured()) {
    const validated = await validateAddressUspsV3({ line1, line2 });
    return { validated, apiStatus: buildUspsV3Status(validated) };
  }
  if (isUspsConfigured()) {
    const validated = await validateAddressUSPS({ line1, line2 });
    return { validated, apiStatus: buildUspsStatus(validated) };
  }
  throw new UspsValidationError('USPS is not configured on the server.', 'NOT_CONFIGURED');
}

/**
 * Resolve a patient's mailing address to a standardized form, real-time.
 *
 * Provider policy (per requirement):
 *   • PRIMARY  — USPS (APIs v3 OAuth preferred; legacy Web Tools USERID as a fallback
 *                path). USPS is the source of truth for US mail.
 *   • BACKUP   — Google Address Validation, used ONLY when USPS cannot identify the
 *                address accurately: not configured, an auth/service error, not found,
 *                incomplete, ambiguous, or DPV unconfirmed.
 *
 * Both providers return the SAME normalized shape, so the caller persists the result
 * identically regardless of source.
 *
 * @param {{line1?: string, line2?: string}} input
 * @returns {Promise<{validated: object, provider: 'usps'|'google', apiStatus: object,
 *                    billable: boolean, uspsError: string|null}>}
 */
export async function resolvePatientAddress({ line1, line2 } = {}) {
  let uspsError = null;

  if (isAnyUspsConfigured()) {
    try {
      const { validated, apiStatus } = await tryUsps({ line1, line2 });
      // USPS succeeded → it is the source of truth. No Google call, no billing.
      return { validated, provider: 'usps', apiStatus, billable: false, uspsError: null };
    } catch (err) {
      if (err instanceof UspsValidationError) {
        uspsError = `${err.code || 'USPS_ERROR'}: ${err.message}`; // fall through to Google backup
      } else {
        throw err; // an unexpected programming error, not a validation miss
      }
    }
  } else {
    uspsError = 'NOT_CONFIGURED: USPS is not configured on the server.';
  }

  // ---- Google Address Validation backup ------------------------------------
  const inputLines = [line1, line2].filter(Boolean);
  const payload = await validateAddress(inputLines);
  const validated = extractValidatedAddress(payload);
  const apiStatus = buildApiStatus('ok', payload?.responseId);
  apiStatus.role = 'backup';
  apiStatus.uspsFallbackReason = uspsError;
  return { validated, provider: 'google', apiStatus, billable: true, uspsError };
}
