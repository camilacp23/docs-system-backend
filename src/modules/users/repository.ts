/**
 * Prisma queries of the users module. No rules live here (SDD Table 6, D-42): the service decides, this only reads
 * and writes. Every read selects explicit columns, so `passwordHash` is never returned.
 *
 * @module modules/users/repository
 */
import type { Prisma, PrismaClient, UserRole, UserStatus } from '../../generated/prisma/client.js';
import { USER_VIEW_SELECT } from '../auth/repository.js';
import { escapeLike } from '../../http/like.js';

/** Clients accepted by the queries: the plain client or the transaction client of `auditedTransaction`. */
export type UsersClient = Pick<PrismaClient, 'user' | 'refreshToken' | '$queryRaw'>;

/** The user as the API returns it (contract schema `User`). */
export type UserView = Prisma.UserGetPayload<{ select: typeof USER_VIEW_SELECT }>;

/** Filters and ordering of `GET /users`. The reserved account is always excluded. */
export type UserListQuery = {
  reservedEmail: string;
  q?: string;
  role?: UserRole;
  status?: UserStatus;
  sort: { field: 'name' | 'email' | 'createdAt' | 'lastLoginAt'; direction: 'asc' | 'desc' };
  skip: number;
  take: number;
};

/** A page of users and the total that matches the filters. */
export async function listUsers(client: UsersClient, query: UserListQuery): Promise<[UserView[], number]> {
  const q = query.q === undefined ? undefined : escapeLike(query.q);
  const where: Prisma.UserWhereInput = {
    email: { not: query.reservedEmail },
    ...(query.role ? { role: query.role } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(q
      ? {
          OR: [{ name: { contains: q, mode: 'insensitive' } }, { email: { contains: q, mode: 'insensitive' } }],
        }
      : {}),
  };
  const { field, direction } = query.sort;
  // lastLoginAt is nullable: users who never signed in always go last. `id` makes the order stable across pages.
  const primary: Prisma.UserOrderByWithRelationInput =
    field === 'lastLoginAt' ? { lastLoginAt: { sort: direction, nulls: 'last' } } : { [field]: direction };
  return Promise.all([
    client.user.findMany({
      where,
      select: USER_VIEW_SELECT,
      orderBy: [primary, { id: 'asc' }],
      skip: query.skip,
      take: query.take,
    }),
    client.user.count({ where }),
  ]);
}

/** Reads one user. */
export function findUserById(client: UsersClient, id: number): Promise<UserView | null> {
  return client.user.findUnique({ where: { id }, select: USER_VIEW_SELECT });
}

/** Creates a user (the e-mail must already be lowercase). */
export function createUser(
  client: UsersClient,
  data: { name: string; email: string; passwordHash: string; role: UserRole },
): Promise<UserView> {
  return client.user.create({ data, select: USER_VIEW_SELECT });
}

/**
 * Locks, in ascending id order and in ONE statement, the target user and every active administrator. The fixed order
 * prevents deadlocks between two concurrent changes; after waiting for a lock PostgreSQL re-evaluates the filter on
 * the new row version, so a demotion committed meanwhile is already visible to the count that follows.
 */
export async function lockTargetAndActiveAdmins(client: UsersClient, targetId: number): Promise<void> {
  await client.$queryRaw`
    SELECT id FROM app_user
     WHERE id = ${targetId} OR (role = 'ADMINISTRATOR'::user_role AND status = 'ACTIVE'::user_status)
     ORDER BY id
       FOR UPDATE`;
}

/** Active administrators other than `excludeId`. */
export function countOtherActiveAdmins(client: UsersClient, excludeId: number): Promise<number> {
  return client.user.count({ where: { role: 'ADMINISTRATOR', status: 'ACTIVE', id: { not: excludeId } } });
}

/** Updates the given columns of a user. */
export function updateUser(client: UsersClient, id: number, data: Prisma.UserUpdateInput): Promise<UserView> {
  return client.user.update({ where: { id }, data, select: USER_VIEW_SELECT });
}

/** Revokes every live refresh token of a user (sessions end at the next refresh). */
export async function revokeUserSessions(client: UsersClient, userId: number, at: Date): Promise<void> {
  await client.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: at } });
}
