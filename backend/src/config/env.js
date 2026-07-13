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
};
