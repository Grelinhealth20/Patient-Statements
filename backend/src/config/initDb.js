import bcrypt from 'bcryptjs';
import { getPool } from './db.js';
import { env } from './env.js';
import { isPhiEncryptionConfigured } from '../utils/crypto.js';
import { backfillPhiEncryption } from './phiBackfill.js';

/**
 * Creates every table the application needs, if it is not already present.
 * Idempotent — safe to run on every boot.
 */
export async function initSchema() {
  // Fail fast (no plaintext fallback): a valid 256-bit PHI key MUST be present before we
  // touch any patient data, so PHI is never read/written without encryption available.
  if (!isPhiEncryptionConfigured()) {
    throw new Error('PHI_ENCRYPTION_KEY is missing or not a base64 32-byte key — refusing to start.');
  }
  const pool = getPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
      username      VARCHAR(64)  NOT NULL,
      email         VARCHAR(160) NOT NULL,
      full_name     VARCHAR(160) NOT NULL DEFAULT '',
      password_hash VARCHAR(255) NOT NULL,
      role          ENUM('super_admin','user') NOT NULL DEFAULT 'user',
      statement_access TINYINT(1) NOT NULL DEFAULT 1,
      is_active     TINYINT(1)   NOT NULL DEFAULT 1,
      token_version INT UNSIGNED NOT NULL DEFAULT 0,
      last_login_at DATETIME NULL,
      created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_users_username (username),
      UNIQUE KEY uq_users_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // One row per generated statement (per patient, per generation run).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS statements (
      id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id        INT UNSIGNED NOT NULL,
      account_number VARCHAR(64)  NOT NULL DEFAULT '',
      patient_name   VARCHAR(191) NOT NULL DEFAULT '',
      patient_key    VARCHAR(160) NOT NULL,
      file_name      VARCHAR(255) NOT NULL,
      dos_count      INT UNSIGNED NOT NULL DEFAULT 0,
      generated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_stmt_user_patient (user_id, patient_key),
      KEY idx_stmt_generated (generated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // One row per unique Date-Of-Service line per patient. The unique key
  // (user_id, patient_key, dos_key) enforces the "Date Of Service only" identity
  // so re-uploads never duplicate a DOS and already-generated DOS are preserved.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS statement_dos (
      id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id        INT UNSIGNED NOT NULL,
      account_number VARCHAR(64)  NOT NULL DEFAULT '',
      patient_name   VARCHAR(191) NOT NULL DEFAULT '',
      patient_key    VARCHAR(160) NOT NULL,
      dos_date       VARCHAR(80)  NOT NULL DEFAULT '',
      dos_key        VARCHAR(80)  NOT NULL,
      data           JSON NOT NULL,
      status         ENUM('pending','generated') NOT NULL DEFAULT 'pending',
      statement_id   BIGINT UNSIGNED NULL,
      source_file    VARCHAR(255) NOT NULL DEFAULT '',
      created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_dos_identity (user_id, patient_key, dos_key),
      KEY idx_dos_user_patient (user_id, patient_key),
      KEY idx_dos_status (user_id, status),
      KEY idx_dos_statement (statement_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Additive migration: S3 archival columns on `statements`. Kept separate from
  // the CREATE TABLE above so existing databases pick them up on the next boot.
  await ensureColumns('statements', [
    { name: 's3_bucket', ddl: 'ADD COLUMN s3_bucket VARCHAR(128) NULL AFTER dos_count' },
    { name: 's3_key', ddl: 'ADD COLUMN s3_key VARCHAR(512) NULL AFTER s3_bucket' },
    { name: 'file_size', ddl: 'ADD COLUMN file_size INT UNSIGNED NULL AFTER s3_key' },
    { name: 'content_type', ddl: "ADD COLUMN content_type VARCHAR(80) NULL AFTER file_size" },
    { name: 'stored_at', ddl: 'ADD COLUMN stored_at DATETIME NULL AFTER content_type' },
  ]);

  // Self-hosted monthly API-usage counter. The backend is the sole caller of the
  // Address Validation API, so it counts its own billable calls here — giving an
  // accurate free-tier vs paid verdict without Cloud Monitoring / a service account.
  // Period is the YYYY-MM billing month (America/Los_Angeles, matching Google's reset).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_usage_monthly (
      metric     VARCHAR(64) NOT NULL,
      period     CHAR(7)     NOT NULL,
      calls      INT UNSIGNED NOT NULL DEFAULT 0,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (metric, period)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      actor_id   INT UNSIGNED NULL,
      action     VARCHAR(80)  NOT NULL,
      target_id  INT UNSIGNED NULL,
      detail     VARCHAR(500) NOT NULL DEFAULT '',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_audit_actor (actor_id),
      KEY idx_audit_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Additive migration: forced first-login password reset. Admin-created accounts and
  // admin password resets set this to 1 (temp password); the user must set a new
  // password before accessing anything. Existing rows default to 0 (unaffected).
  await ensureColumns('users', [
    { name: 'must_change_password', ddl: 'ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 0 AFTER token_version' },
  ]);

  // Additive migration: denormalized Patient Date of Birth captured on import (also
  // kept in the row's JSON `data`). Existing rows default to '' until re-imported.
  await ensureColumns('statement_dos', [
    { name: 'patient_dob', ddl: "ADD COLUMN patient_dob VARCHAR(40) NOT NULL DEFAULT '' AFTER patient_name" },
  ]);

  // PHI-at-rest migration. The `data` column now holds an AES-256-GCM ciphertext token
  // (not queryable JSON), so the few non-PHI facts SQL needs are promoted to dedicated
  // columns and kept in sync on every write. This preserves search, the validated /
  // has-address flags and the financial summary WITHOUT reading into the encrypted blob.
  await ensureColumns('statement_dos', [
    { name: 'av_provider', ddl: 'ADD COLUMN av_provider VARCHAR(16) NULL AFTER status' },
    { name: 'has_patient_address', ddl: 'ADD COLUMN has_patient_address TINYINT(1) NOT NULL DEFAULT 0 AFTER av_provider' },
    { name: 'patient_responsibility', ddl: 'ADD COLUMN patient_responsibility DECIMAL(14,2) NULL AFTER has_patient_address' },
  ]);
  // Widen `data` from JSON to LONGTEXT so it can hold the ciphertext token. MySQL
  // converts existing JSON rows to their canonical JSON text (no data loss); the reader
  // (unpackData) still parses that legacy text until the backfill encrypts it.
  await ensureDataColumnIsText();

  await seedSuperAdmin();

  // Encrypt any existing (or newly imported, pre-key) plaintext rows in the background.
  // Runs only when a key is configured; reads stay backward-compatible while it works,
  // so it never blocks boot and callers never see a half-migrated row incorrectly.
  if (isPhiEncryptionConfigured()) {
    backfillPhiEncryption().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[phi] background backfill error:', err.message);
    });
  }
}

/**
 * Ensure statement_dos.data is LONGTEXT (it started life as JSON). Idempotent: checks
 * information_schema and only ALTERs when the column is still JSON, so it is safe to run
 * on every boot and a no-op once migrated.
 */
async function ensureDataColumnIsText() {
  const pool = getPool();
  const [[col]] = await pool.query(
    `SELECT DATA_TYPE AS type
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'statement_dos' AND COLUMN_NAME = 'data'`
  );
  if (col && String(col.type).toLowerCase() === 'json') {
    await pool.query('ALTER TABLE `statement_dos` MODIFY COLUMN `data` LONGTEXT NOT NULL');
  }
}

/**
 * Idempotently add columns to an existing table. Each column is only added when
 * it is missing (checked via information_schema), so this is safe to run on
 * every boot and never fails on a database that already has the columns.
 *
 * @param {string} table
 * @param {{name: string, ddl: string}[]} columns  ddl is the ALTER TABLE clause.
 */
async function ensureColumns(table, columns) {
  const pool = getPool();
  const [existing] = await pool.query(
    `SELECT COLUMN_NAME AS name
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table`,
    { table }
  );
  const have = new Set(existing.map((r) => String(r.name)));
  const missing = columns.filter((c) => !have.has(c.name));
  if (!missing.length) return;
  // One ALTER for all missing columns keeps the migration atomic and fast.
  await pool.query(`ALTER TABLE \`${table}\` ${missing.map((c) => c.ddl).join(', ')}`);
}

/**
 * Ensures a bootstrap super administrator always exists so the very first
 * login is possible on a brand-new database.
 */
async function seedSuperAdmin() {
  const pool = getPool();
  const { username, email, password, name } = env.superAdmin;

  const [rows] = await pool.query(
    `SELECT id FROM users WHERE role = 'super_admin' LIMIT 1`
  );
  if (rows.length > 0) return;

  const passwordHash = await bcrypt.hash(password, 12);
  await pool.query(
    `INSERT INTO users (username, email, full_name, password_hash, role, statement_access, is_active)
     VALUES (:username, :email, :name, :hash, 'super_admin', 1, 1)`,
    { username, email, name, hash: passwordHash }
  );

  // eslint-disable-next-line no-console
  console.log(
    `\n  [seed] Bootstrap super admin created:\n         username: ${username}\n         password: ${password}\n         (change this immediately after first login)\n`
  );
}

export async function writeAudit({ actorId = null, action, targetId = null, detail = '' }) {
  try {
    const pool = getPool();
    await pool.query(
      `INSERT INTO audit_logs (actor_id, action, target_id, detail)
       VALUES (:actorId, :action, :targetId, :detail)`,
      { actorId, action, targetId, detail: String(detail).slice(0, 500) }
    );
  } catch {
    /* auditing must never break a request */
  }
}
