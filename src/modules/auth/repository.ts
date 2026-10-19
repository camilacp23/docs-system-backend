/**
 * Prisma queries of the authentication module. No rules live here (SDD Table 6, D-42): the service decides, this
 * only reads and writes. Every user read selects explicit columns, so `passwordHash` never leaves except where the
 * service needs it to verify a password.
 *
 * @module modules/auth/repository
 */
import type { PrismaClient, RefreshToken } from '../../generated/prisma/client.js';

/** Clients accepted by the queries: the plain client or the transaction client of `$transaction`. */
export type AuthClient = Pick<PrismaClient, 'user' | 'refreshToken'>;

/** The user as the API returns it (contract schema `User`). */
export const USER_VIEW_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  status: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Finds the account by its (lowercase) e-mail, with the hash needed to verify the password. */
export function findAccountByEmail(client: AuthClient, email: string) {
  return client.user.findUnique({ where: { email }, select: { ...USER_VIEW_SELECT, passwordHash: true } });
}

/** Stores a refresh token. Only its SHA-256 is saved, never the token. */
export function createRefreshToken(
  client: AuthClient,
  data: { userId: number; tokenHash: string; familyId: string; expiresAt: Date },
): Promise<RefreshToken> {
  return client.refreshToken.create({ data });
}

/** Sets `last_login_at`; must run inside the audit context of the user (the trigger records the actor). */
export function touchLastLogin(client: AuthClient, userId: number, at: Date) {
  return client.user.update({ where: { id: userId }, data: { lastLoginAt: at }, select: USER_VIEW_SELECT });
}

/** Finds a refresh token by the hash of its value, with the user it belongs to. */
export function findTokenWithUser(client: AuthClient, tokenHash: string) {
  return client.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: { select: USER_VIEW_SELECT } },
  });
}

/** Finds a refresh token by the hash of its value (family lookup for logout). */
export function findTokenByHash(client: AuthClient, tokenHash: string) {
  return client.refreshToken.findUnique({ where: { tokenHash } });
}

/**
 * Consumes a token exactly once: the conditional update only matches while it is not revoked.
 *
 * @returns true when this call consumed it, false when it was already consumed (another request won).
 */
export async function consumeToken(client: AuthClient, id: bigint, at: Date): Promise<boolean> {
  const result = await client.refreshToken.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: at } });
  return result.count === 1;
}

/** Revokes every live token of a family. */
export async function revokeFamily(client: AuthClient, familyId: string, at: Date): Promise<void> {
  await client.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: at } });
}
