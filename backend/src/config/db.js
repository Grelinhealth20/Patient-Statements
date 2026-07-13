import mysql from 'mysql2/promise';
import { env } from './env.js';

/**
 * A single shared connection pool for the whole application.
 * The pool lazily creates the target database if it does not yet exist,
 * so the first boot on a fresh MySQL server is fully automatic.
 */
let pool;

async function ensureDatabaseExists() {
  const bootstrap = await mysql.createConnection({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    multipleStatements: false,
  });

  await bootstrap.query(
    `CREATE DATABASE IF NOT EXISTS \`${env.db.database}\`
       CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await bootstrap.end();
}

export async function initPool() {
  if (pool) return pool;

  await ensureDatabaseExists();

  pool = mysql.createPool({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: env.db.database,
    waitForConnections: true,
    // Kept small so many concurrent serverless instances don't exhaust MySQL's
    // max_connections. Tune with DB_POOL_LIMIT (default 5; use 2-3 on Vercel).
    connectionLimit: Number(process.env.DB_POOL_LIMIT || 5),
    queueLimit: 0,
    idleTimeout: 30000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    namedPlaceholders: true,
  });

  // Fail fast if credentials / network are wrong.
  const conn = await pool.getConnection();
  await conn.ping();
  conn.release();

  return pool;
}

export function getPool() {
  if (!pool) {
    throw new Error('Database pool has not been initialised. Call initPool() first.');
  }
  return pool;
}
