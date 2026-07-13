import bcrypt from 'bcryptjs';
import { getPool } from './db.js';
import { env } from './env.js';

/**
 * Creates every table the application needs, if it is not already present.
 * Idempotent — safe to run on every boot.
 */
export async function initSchema() {
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

  await seedSuperAdmin();
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
