import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

/**
 * Access tokens are short-lived (40 minutes). The `tv` (token version) claim
 * lets us instantly invalidate all of a user's tokens by bumping their
 * `token_version` column (used on password reset / access revocation / delete).
 */
export function signAccessToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
      tv: user.token_version,
    },
    env.jwt.accessSecret,
    { expiresIn: env.jwt.accessExpires }
  );
}

export function signRefreshToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      tv: user.token_version,
    },
    env.jwt.refreshSecret,
    { expiresIn: env.jwt.refreshExpires }
  );
}

export function verifyAccessToken(token) {
  return jwt.verify(token, env.jwt.accessSecret);
}

export function verifyRefreshToken(token) {
  return jwt.verify(token, env.jwt.refreshSecret);
}

/** Returns access-token lifetime in seconds so the client can schedule refresh. */
export function accessTokenTtlSeconds() {
  const decoded = jwt.decode(
    jwt.sign({}, env.jwt.accessSecret, { expiresIn: env.jwt.accessExpires })
  );
  return decoded.exp - decoded.iat;
}
