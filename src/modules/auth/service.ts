/**
 * Authentication rules (FR-01, NFR-01, NFR-02; SDD 8.3, 11.2; D-27, D-36, D-38, D-61).
 *
 * Login verifies the password in constant time, opens a session that ends `sessionMaxSeconds` later and records the
 * login. Refresh rotates the token once, keeps the original end of the session and revokes the whole family when a
 * rotated token comes back. Logout revokes the family. The service never sees req/res.
 *
 * @module modules/auth/service
 */
import { randomUUID } from 'node:crypto';
import { auditContext, type Database } from '../../db/prisma.js';
import { E } from '../../security/errors.js';
import { isIntegrationEmail, security } from '../../security/config.js';
import { verifyPassword } from '../../security/passwords.js';
import { hashRefreshToken, newRefreshToken, signAccessToken } from '../../security/tokens.js';
import * as repo from './repository.js';

/** What login and refresh return to the controller. */
export type SessionResult = {
  accessToken: string;
  /** Opaque value for the `rt` cookie; never stored or logged. */
  refreshToken: string;
  /** Absolute end of the session (the cookie's Expires). */
  sessionExpiresAt: Date;
  /** Seconds the access token lives (NFR-01). */
  expiresIn: number;
  /** Seconds until `sessionExpiresAt` (D-61). */
  sessionExpiresIn: number;
  user: Awaited<ReturnType<typeof repo.touchLastLogin>>;
};

/** The authentication service. */
export type AuthService = {
  login(email: string, password: string): Promise<SessionResult>;
  refresh(rawToken: string | undefined): Promise<SessionResult>;
  logout(rawToken: string | undefined): Promise<void>;
};

/** Seconds left until `end`, never negative and never more than the maximum session length. */
export function secondsUntil(end: Date, now: Date = new Date()): number {
  const left = Math.ceil((end.getTime() - now.getTime()) / 1000);
  return Math.min(Math.max(left, 0), security.sessionMaxSeconds);
}

/**
 * Creates the authentication service.
 *
 * @param db - Database connected as docs_app.
 */
export function createAuthService(db: Pick<Database, 'base' | 'auditedTransaction'>): AuthService {
  const result = (
    userId: number,
    refreshToken: string,
    sessionExpiresAt: Date,
    user: SessionResult['user'],
  ): SessionResult => ({
    accessToken: signAccessToken(userId),
    refreshToken,
    sessionExpiresAt,
    expiresIn: security.accessTtlSeconds,
    sessionExpiresIn: secondsUntil(sessionExpiresAt),
    user,
  });

  return {
    async login(email, password) {
      // CP-06: the reserved account gets the standard 401 before its password is compared. bcrypt still runs (against
      // no hash, as for an unknown e-mail) so the response time does not reveal that the account exists.
      if (isIntegrationEmail(email)) {
        await verifyPassword(password, undefined);
        throw E.invalidCredentials();
      }
      const account = await repo.findAccountByEmail(db.base, email.trim().toLowerCase());
      const matches = await verifyPassword(password, account?.passwordHash); // always runs bcrypt (timing, D-27)
      if (!account || !matches || account.status !== 'ACTIVE') throw E.invalidCredentials();

      const now = new Date();
      const sessionExpiresAt = new Date(now.getTime() + security.sessionMaxSeconds * 1000);
      const { raw, hash } = newRefreshToken();
      // One transaction, with the user as audit actor (R-2): the session exists if and only if the login is recorded.
      const user = await auditContext.run({ userId: account.id }, () =>
        db.auditedTransaction(async (tx) => {
          await repo.createRefreshToken(tx, {
            userId: account.id,
            tokenHash: hash,
            familyId: randomUUID(),
            expiresAt: sessionExpiresAt,
          });
          return repo.touchLastLogin(tx, account.id, now);
        }),
      );
      return result(account.id, raw, sessionExpiresAt, user);
    },

    async refresh(rawToken) {
      if (!rawToken) throw E.refreshInvalid();
      const row = await repo.findTokenWithUser(db.base, hashRefreshToken(rawToken));
      if (!row) throw E.refreshInvalid();
      if (row.revokedAt) {
        // A rotated token was presented again: assume theft and revoke the whole family (D-38).
        await repo.revokeFamily(db.base, row.familyId, new Date());
        throw E.refreshInvalid();
      }
      if (row.expiresAt <= new Date() || row.user.status !== 'ACTIVE') throw E.refreshInvalid();

      // Rotation: the presented token is consumed exactly once. The new token keeps the original end of the session,
      // so refreshing never extends it (NFR-01).
      const { raw, hash } = newRefreshToken();
      const rotated = await db.base.$transaction(async (tx) => {
        if (!(await repo.consumeToken(tx, row.id, new Date()))) return false;
        await repo.createRefreshToken(tx, {
          userId: row.userId,
          tokenHash: hash,
          familyId: row.familyId,
          expiresAt: row.expiresAt,
        });
        return true;
      });
      if (!rotated) {
        // Lost a race with another refresh of the same token: that is a reuse of a rotated token (D-38, no grace).
        // The revocation runs outside the transaction above so the 401 cannot undo it.
        await repo.revokeFamily(db.base, row.familyId, new Date());
        throw E.refreshInvalid();
      }
      return result(row.userId, raw, row.expiresAt, row.user);
    },

    async logout(rawToken) {
      if (!rawToken) return;
      const row = await repo.findTokenByHash(db.base, hashRefreshToken(rawToken));
      if (row) await repo.revokeFamily(db.base, row.familyId, new Date());
    },
  };
}
