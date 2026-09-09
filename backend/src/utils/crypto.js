import crypto from 'crypto';
import { env } from '../config/env.js';

/**
 * Application-layer PHI encryption (encryption at rest).
 *
 * Patient records are encrypted with AES-256-GCM before being written to the database
 * and decrypted transparently on read, so no plaintext PHI (names, addresses, DOB,
 * financials, clinical DOS detail) is ever persisted in the `statement_dos.data`
 * column. AES-GCM is authenticated encryption — every value carries a 128-bit auth
 * tag, so any tampering or key mismatch is detected on decrypt rather than returning
 * garbage.
 *
 * Ciphertext format (a single self-describing string):
 *     enc:v1:<base64( iv[12] | tag[16] | ciphertext )>
 *
 * Keys come from the environment only (never source): PHI_ENCRYPTION_KEY is the active
 * key (base64 of 32 bytes); PHI_ENCRYPTION_KEYS_OLD is an optional comma-separated list
 * of retired keys kept so data written under a previous key still decrypts during a
 * rotation. Decryption tries the active key first, then each old key — the GCM auth tag
 * tells us unambiguously which key a value belongs to.
 *
 * There is NO plaintext fallback: writes fail closed. If no key is configured, packData
 * throws rather than persisting unencrypted PHI. (Reads still accept legacy plaintext so
 * the one-time backfill can migrate pre-encryption rows — reading existing data is not a
 * fallback, it is the migration path.)
 */

const ALG = 'aes-256-gcm';
const PREFIX = 'enc:v1:';
const IV_LEN = 12;   // 96-bit nonce (GCM standard)
const TAG_LEN = 16;  // 128-bit auth tag

let _cache = null;

/** Parse a base64 key into a 32-byte Buffer, or null when malformed. */
function parseKey(b64) {
  if (!b64) return null;
  try {
    const buf = Buffer.from(String(b64).trim(), 'base64');
    return buf.length === 32 ? buf : null;
  } catch {
    return null;
  }
}

/** Load + cache the active key and the ordered list of decryption keys. */
function keys() {
  if (_cache) return _cache;
  const active = parseKey(env.security.phiKey);
  const all = [];
  if (active) all.push(active);
  for (const k of String(env.security.phiKeysOld || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const b = parseKey(k);
    if (b) all.push(b);
  }
  _cache = { active: active || null, all };
  return _cache;
}

/** True when a valid 256-bit active key is configured (encryption is ON). */
export function isPhiEncryptionConfigured() {
  return !!keys().active;
}

/** True when `v` is one of our AES-GCM ciphertext tokens. */
export function isEncrypted(v) {
  return typeof v === 'string' && v.startsWith(PREFIX);
}

/** Encrypt a UTF-8 string, returning an `enc:v1:` token. */
export function encryptString(plaintext) {
  const { active } = keys();
  if (!active) throw new Error('PHI encryption key is not configured.');
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALG, active, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

/** Decrypt an `enc:v1:` token (trying active then retired keys). */
export function decryptString(token) {
  if (!isEncrypted(token)) throw new Error('Value is not an encrypted PHI token.');
  const raw = Buffer.from(token.slice(PREFIX.length), 'base64');
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = raw.subarray(IV_LEN + TAG_LEN);
  const list = keys().all;
  if (!list.length) throw new Error('PHI encryption key is not configured; cannot decrypt.');
  let lastErr;
  for (const key of list) {
    try {
      const d = crypto.createDecipheriv(ALG, key, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
    } catch (e) {
      lastErr = e; // wrong key → auth tag fails; try the next
    }
  }
  throw new Error(`PHI decryption failed (no matching key): ${lastErr?.message || 'unknown'}`);
}

/* ------------------------------------------------ DOS `data` column codec */

/**
 * Serialize a DOS `data` object for storage — ALWAYS encrypted. Fails closed: if no key
 * is configured it throws instead of writing plaintext PHI (no fallback). Returns an
 * `enc:v1:` string suitable for the LONGTEXT `data` column.
 */
export function packData(obj) {
  if (!isPhiEncryptionConfigured()) {
    throw new Error('Refusing to store PHI unencrypted: PHI_ENCRYPTION_KEY is not configured.');
  }
  return encryptString(JSON.stringify(obj ?? {}));
}

/**
 * Inverse of packData — the single, backward-compatible reader used everywhere the
 * `data` column is read. Accepts an already-parsed object (a legacy JSON-column value),
 * an `enc:v1:` token, or a plain JSON string, and always returns an object. This is
 * what makes the rollout safe and real-time: encrypted and not-yet-migrated rows both
 * read correctly while the backfill runs.
 */
export function unpackData(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;              // mysql2 already parsed a JSON column
  if (isEncrypted(raw)) return JSON.parse(decryptString(raw));
  try {
    return JSON.parse(raw);                             // legacy plain JSON text
  } catch {
    return {};
  }
}

/* -------------------------------------------- derived (non-PHI) helper columns */

/**
 * Parse a free-form money value ("$23.85 ", "1,234.00") to a Number, or null when it
 * carries no digits. Mirrors the client's money() parser so the financial summary
 * matches exactly.
 */
export function parseMoney(v) {
  const cleaned = String(v == null ? '' : v).replace(/[^0-9.-]/g, '');
  if (!/[0-9]/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Derive the queryable, NON-PHI helper columns from a decrypted `data` object. These
 * are what SQL uses (instead of reading into the encrypted blob) so search, the
 * validated flag, the has-address flag and the financial summary keep working exactly
 * as before:
 *   - avProvider           'usps' | 'google' | null  (address-validation provider)
 *   - hasPatientAddress    0 | 1                      (any patient address on file)
 *   - patientResponsibility Number | null             (outstanding amount, for SUM)
 */
export function phiHelperColumns(data) {
  const d = data || {};
  const prov = d.addressValidationProvider === 'usps' || d.addressValidationProvider === 'google'
    ? d.addressValidationProvider
    : null;
  const hasAddr = (String(d.patientAddress1 || '').trim() || String(d.patientAddress2 || '').trim()) ? 1 : 0;
  return { avProvider: prov, hasPatientAddress: hasAddr, patientResponsibility: parseMoney(d.patientResponsibility) };
}
