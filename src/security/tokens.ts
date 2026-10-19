/** Access tokens (JWT HS256, 8 h) and opaque refresh tokens (NFR-01). */
import jwt from 'jsonwebtoken';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { security } from './config.js';

export type AccessClaims = { sub: string; jti: string; iat: number; exp: number };

export function signAccessToken(userId: number): string {
  const [key] = security.keys;
  return jwt.sign({}, key.secret, {
    algorithm: 'HS256', keyid: key.kid, subject: String(userId), jwtid: randomUUID(),
    issuer: security.issuer, audience: security.audience, expiresIn: security.accessTtlSeconds,
  });
}

/** Throws jwt.TokenExpiredError or jwt.JsonWebTokenError. Only HS256 is accepted ("none" and others are rejected). */
export function verifyAccessToken(token: string): AccessClaims {
  const header = jwt.decode(token, { complete: true })?.header;
  const key = security.keys.find((k) => k.kid === header?.kid);
  if (!key) throw new jwt.JsonWebTokenError('unknown key id');
  return jwt.verify(token, key.secret, { algorithms: ['HS256'], issuer: security.issuer, audience: security.audience }) as AccessClaims;
}

/** Opaque refresh token: 256 random bits; only its SHA-256 is stored (refresh_token.token_hash). */
export function newRefreshToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: hashRefreshToken(raw) };
}
export const hashRefreshToken = (raw: string) => createHash('sha256').update(raw).digest('hex');
