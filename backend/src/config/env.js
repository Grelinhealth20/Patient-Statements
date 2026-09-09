import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const required = (key, fallback) => {
  const value = process.env[key] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 5000),
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',

  db: {
    host: required('DB_HOST'),
    port: Number(process.env.DB_PORT || 3306),
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
    database: required('DB_NAME'),
  },

  jwt: {
    accessSecret: required('JWT_ACCESS_SECRET'),
    refreshSecret: required('JWT_REFRESH_SECRET'),
    accessExpires: process.env.JWT_ACCESS_EXPIRES || '40m',
    refreshExpires: process.env.JWT_REFRESH_EXPIRES || '8h',
  },

  superAdmin: {
    username: process.env.SUPER_ADMIN_USERNAME || 'superadmin',
    email: process.env.SUPER_ADMIN_EMAIL || 'admin@grelinhealth.com',
    password: process.env.SUPER_ADMIN_PASSWORD || 'change-me-in-env',
    name: process.env.SUPER_ADMIN_NAME || 'Super Administrator',
  },

  // Google Cloud Address Validation API — the SOLE address validator (source of truth
  // for US mail). Authenticated with a single Google API key, server-side only; no
  // other address-validation API is used anywhere in the app. Supply the key via
  // GOOGLE_ADDRESS_VALIDATION_API_KEY (or GOOGLE_API_KEY) in the environment
  // (backend/.env locally, or a project secret in production). The key must be
  // restricted to the Address Validation API. No secret is committed to source.
  google: {
    apiKey:
      process.env.GOOGLE_ADDRESS_VALIDATION_API_KEY ||
      process.env.GOOGLE_API_KEY ||
      '',
    apiBase: process.env.GOOGLE_ADDRESS_VALIDATION_BASE || 'https://addressvalidation.googleapis.com',
  },

  // PHI-at-rest encryption. Patient records (names, addresses, DOB, financials,
  // clinical DOS detail) are encrypted with AES-256-GCM before they are written to
  // the database and decrypted transparently on read. PHI_ENCRYPTION_KEY is a base64
  // encoding of 32 random bytes (a 256-bit key); generate one with:
  //   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  // Keep it in the environment / a secret manager — NEVER in source or the repo.
  // Losing the key makes existing PHI unrecoverable. PHI_ENCRYPTION_KEYS_OLD is an
  // optional comma-separated list of retired keys, kept only so data written under a
  // previous key can still be decrypted during a key rotation.
  // Required — the app refuses to boot without a PHI key, so PHI is never handled or
  // stored without encryption (no plaintext fallback).
  security: {
    phiKey: required('PHI_ENCRYPTION_KEY'),
    phiKeysOld: process.env.PHI_ENCRYPTION_KEYS_OLD || '',
  },

  s3: {
    // Durable storage for generated statement PDFs. All values are server-side
    // only; credentials are never exposed to the browser. When accessKeyId /
    // secretAccessKey are omitted the AWS default credential provider chain is
    // used (IAM role, shared config, etc.), which is preferred in production.
    region: process.env.S3_REGION || process.env.AWS_REGION || 'us-east-1',
    bucket: process.env.S3_BUCKET || '',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    // Key prefix (folder) under which statement PDFs are stored.
    keyPrefix: process.env.S3_KEY_PREFIX || 'statements',
    // Lifetime of the presigned download URLs handed to the browser.
    presignExpirySeconds: Number(process.env.S3_PRESIGN_EXPIRY_SECONDS || 300),
    // Hard upper bound on an uploaded PDF (defense against oversized payloads).
    maxPdfBytes: Number(process.env.S3_MAX_PDF_BYTES || 26214400), // 25 MiB
  },
};
