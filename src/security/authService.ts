/** Login, refresh-token rotation with reuse detection, logout, and session revocation. */
import { randomUUID } from 'node:crypto';
import { security, isIntegrationEmail } from './config.js';
import { verifyPassword } from './passwords.js';
import { newRefreshToken, hashRefreshToken, signAccessToken } from './tokens.js';
import { E } from './errors.js';
import { auditContext } from '../db/prisma.js';

type Db = any; // { prisma, base } from createPrisma()

export function createAuthService({ prisma, base }: Db) {
  const userView = (u: any) => ({ id: u.id, name: u.name, email: u.email, role: u.role, status: u.status, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt, updatedAt: u.updatedAt });

  /** expiresAt is the session's absolute end: set once at login and inherited by every rotation. */
  async function issueSession(userId: number, familyId: string, expiresAt: Date) {
    const { raw, hash } = newRefreshToken();
    await base.refreshToken.create({ data: { userId, tokenHash: hash, familyId, expiresAt } });
    return { accessToken: signAccessToken(userId), refreshToken: raw, sessionExpiresAt: expiresAt };
  }

  return {
    async login(email: string, password: string) {
      // CP-06: the reserved integration account gets the standard 401 before its password is
      // compared. bcrypt still runs (against no hash, as for an unknown e-mail) so the response
      // time does not reveal that the account exists.
      if (isIntegrationEmail(email)) {
        await verifyPassword(password, undefined);
        throw E.invalidCredentials();
      }
      const user = await base.user.findUnique({ where: { email: email.trim().toLowerCase() } });
      const ok = await verifyPassword(password, user?.passwordHash);          // always runs bcrypt (timing)
      if (!user || !ok || user.status !== 'ACTIVE') throw E.invalidCredentials();
      const session = await issueSession(user.id, randomUUID(), new Date(Date.now() + security.sessionMaxSeconds * 1000));
      const updated = await auditContext.run({ userId: user.id }, async () =>
        await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }));
      return { ...session, user: userView(updated) };
    },

    async refresh(raw: string | undefined) {
      if (!raw) throw E.refreshInvalid();
      const row = await base.refreshToken.findUnique({ where: { tokenHash: hashRefreshToken(raw) }, include: { user: true } });
      if (!row) throw E.refreshInvalid();
      if (row.revokedAt) {
        // A rotated token was presented again: assume theft and revoke the whole family.
        await base.refreshToken.updateMany({ where: { familyId: row.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
        throw E.refreshInvalid();
      }
      if (row.expiresAt <= new Date() || row.user.status !== 'ACTIVE') throw E.refreshInvalid();
      // Rotation: the presented token is consumed exactly once (conditional update guards against races).
      const consumed = await base.refreshToken.updateMany({ where: { id: row.id, revokedAt: null }, data: { revokedAt: new Date() } });
      if (consumed.count !== 1) throw E.refreshInvalid();
      const session = await issueSession(row.userId, row.familyId, row.expiresAt);   // same end: rotation never extends the session
      return { ...session, user: userView(row.user) };
    },

    async logout(raw: string | undefined) {
      if (!raw) return;
      const row = await base.refreshToken.findUnique({ where: { tokenHash: hashRefreshToken(raw) } });
      if (row) await base.refreshToken.updateMany({ where: { familyId: row.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
    },

    /** Used on deactivation, password change and role change. */
    revokeAllSessions: (userId: number) =>
      base.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
  };
}
