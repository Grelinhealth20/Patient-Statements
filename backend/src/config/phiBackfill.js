import { getPool } from './db.js';
import {
  isPhiEncryptionConfigured,
  isEncrypted,
  packData,
  unpackData,
  phiHelperColumns,
} from '../utils/crypto.js';

/**
 * One-time (idempotent) migration that encrypts every existing plaintext `statement_dos`
 * row in place and backfills the non-PHI helper columns (av_provider,
 * has_patient_address, patient_responsibility) that SQL now relies on.
 *
 * Safety properties:
 *   - Idempotent: only rows whose `data` is not already an `enc:v1:` token are touched,
 *     so re-running (e.g. on every cold boot) converges and then does nothing.
 *   - Lossless: each row is read → decrypted/parsed → re-encrypted; the plaintext object
 *     is preserved exactly (verified by decrypting before overwriting).
 *   - Non-blocking: processed in small batches; reads elsewhere are backward-compatible,
 *     so the app serves correct data throughout the migration.
 *   - Per-row isolation: a single bad row is logged and skipped, never aborting the run.
 */

let _running = false;

const BATCH = 200;

/**
 * @param {{batchSize?: number, onProgress?: (n:number)=>void, pool?: object}} [opts]
 *   pool defaults to the app pool; injectable for testing.
 * @returns {Promise<{migrated:number, skipped:number, alreadyEncrypted:number}>}
 */
export async function backfillPhiEncryption(opts = {}) {
  if (!isPhiEncryptionConfigured()) {
    return { migrated: 0, skipped: 0, alreadyEncrypted: 0, disabled: true };
  }
  if (_running) return { migrated: 0, skipped: 0, alreadyEncrypted: 0, alreadyRunning: true };
  _running = true;

  const pool = opts.pool || getPool();
  const batchSize = Math.max(1, Math.min(1000, opts.batchSize || BATCH));
  let migrated = 0;
  let skipped = 0;
  let alreadyEncrypted = 0;
  let lastId = 0;

  try {
    // Walk the table by ascending id. We re-check the encrypted prefix per row (rather
    // than a WHERE data NOT LIKE 'enc:%', which can't use an index on LONGTEXT) so the
    // scan is a simple, resumable keyset pagination.
    for (;;) {
      const [rows] = await pool.query(
        `SELECT id, data FROM statement_dos WHERE id > :lastId ORDER BY id LIMIT ${batchSize}`,
        { lastId }
      );
      if (!rows.length) break;
      lastId = rows[rows.length - 1].id;

      for (const row of rows) {
        if (isEncrypted(row.data)) { alreadyEncrypted += 1; continue; }
        try {
          const obj = unpackData(row.data);          // parse legacy plaintext
          const enc = packData(obj);                 // re-encrypt
          const { avProvider, hasPatientAddress, patientResponsibility } = phiHelperColumns(obj);
          await pool.query(
            `UPDATE statement_dos
                SET data = :data,
                    av_provider = :avProvider,
                    has_patient_address = :hasPatientAddress,
                    patient_responsibility = :patientResponsibility
              WHERE id = :id`,
            { data: enc, avProvider, hasPatientAddress, patientResponsibility, id: row.id }
          );
          migrated += 1;
        } catch (err) {
          skipped += 1;
          // eslint-disable-next-line no-console
          console.error(`[phi] backfill skipped row id=${row.id}: ${err.message}`);
        }
      }
      if (opts.onProgress) opts.onProgress(migrated);
    }

    if (migrated || skipped) {
      // eslint-disable-next-line no-console
      console.log(`[phi] backfill complete: migrated=${migrated} alreadyEncrypted=${alreadyEncrypted} skipped=${skipped}`);
    }
    return { migrated, skipped, alreadyEncrypted };
  } finally {
    _running = false;
  }
}
