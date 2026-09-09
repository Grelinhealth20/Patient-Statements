/**
 * Standalone one-off migration: encrypt all existing plaintext PHI in statement_dos
 * and backfill the non-PHI helper columns. Safe to run repeatedly (idempotent).
 *
 * Usage (from backend/):  node src/scripts/encryptExistingPhi.js
 * Requires PHI_ENCRYPTION_KEY (and DB_* / JWT_* ) in the environment / backend/.env.
 *
 * The app also runs this automatically in the background on boot, but running it
 * explicitly gives a clear, awaited, logged full pass (e.g. right after deploying the
 * key) and a non-zero exit code if it cannot proceed.
 */
import { initPool } from '../config/db.js';
import { initSchema } from '../config/initDb.js';
import { isPhiEncryptionConfigured } from '../utils/crypto.js';
import { backfillPhiEncryption } from '../config/phiBackfill.js';

async function main() {
  if (!isPhiEncryptionConfigured()) {
    console.error('PHI_ENCRYPTION_KEY is not set (or not 32 bytes base64). Aborting — refusing to run without a key.');
    process.exit(1);
  }
  await initPool();
  await initSchema(); // ensures columns + data column type exist before the pass
  console.log('[phi] starting full encryption backfill…');
  const t0 = Date.now();
  const res = await backfillPhiEncryption({ batchSize: 500, onProgress: (n) => process.stdout.write(`\r[phi] migrated ${n}…`) });
  process.stdout.write('\n');
  console.log(`[phi] done in ${((Date.now() - t0) / 1000).toFixed(1)}s:`, JSON.stringify(res));
  process.exit(0);
}

main().catch((err) => {
  console.error('[phi] migration failed:', err);
  process.exit(1);
});
