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

  // USPS — the SOLE address validator (source of truth for US mail). Server-side only.
  // Two supported auth paths, preferred in this order:
  //   1) USPS APIs v3 (apis.usps.com) — OAuth2 client_credentials with a Consumer Key
  //      (clientId) + Consumer Secret (clientSecret), scope "addresses". Current USPS
  //      platform (the legacy Web Tools address APIs were retired).
  //   2) Legacy Web Tools (secure.shippingapis.com) — USERID only. Fallback path for
  //      accounts still provisioned on Web Tools.
  usps: {
    // USPS APIs v3 (OAuth2)
    clientId: process.env.USPS_CLIENT_ID || '',
    clientSecret: process.env.USPS_CLIENT_SECRET || '',
    apiBase: process.env.USPS_API_BASE || 'https://apis.usps.com',
    // Legacy Web Tools (USERID)
    userId: process.env.USPS_USERID || '',
    endpoint: process.env.USPS_ENDPOINT || 'https://secure.shippingapis.com/ShippingAPI.dll',
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
