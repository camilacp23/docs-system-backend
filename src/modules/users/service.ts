/**
 * User administration rules (FR-02, FR-03, FR-04; SDD Table 46, D-09, D-25, D-38, D-51, D-62).
 *
 * Every change to an existing user runs in one `auditedTransaction` that FIRST locks the target and all active
 * administrators (see `lockTargetAndActiveAdmins`), so "the last active administrator" is decided on committed data
 * and two administrators demoting each other at once cannot leave zero. Checks run in this order: 404, reserved
 * account (422), If-Match (412), self-deactivation and last administrator (422), then e-mail uniqueness (409, from the
 * database constraint). Sessions are revoked in the same transaction as the change. The service never sees req/res.
 *
 * @module modules/users/service
 */
import type { Database } from '../../db/prisma.js';
import type { UserRole, UserStatus } from '../../generated/prisma/client.js';
import { etagOf } from '../../http/etag.js';
import { isIntegrationEmail, security } from '../../security/config.js';
import { E } from '../../security/errors.js';
import { hashPassword } from '../../security/passwords.js';
import { USER_VIEW_SELECT } from '../auth/repository.js';
import * as repo from './repository.js';

/** Noun of the resource in messages. */
const ELEMENT = 'user';

/** Throws the 412 when the supplied `If-Match` differs from the ETag read inside the transaction. */
export type PreconditionCheck = (currentETag: string) => void;

/** Filters of the listing, already parsed by the controller. */
export type ListUsersInput = {
  q?: string | undefined;
  role?: UserRole | undefined;
  status?: UserStatus | undefined;
  sort: repo.UserListQuery['sort'];
  skip: number;
  take: number;
};

/** The users service. */
export type UserService = {
  list(input: ListUsersInput): Promise<{ data: repo.UserView[]; total: number }>;
  create(input: { name: string; email: string; password: string; role: UserRole }): Promise<repo.UserView>;
  get(id: number): Promise<repo.UserView>;
  update(
    actorId: number,
    id: number,
    input: { name: string; email: string; status: UserStatus; password?: string | undefined },
    assertCurrent: PreconditionCheck,
  ): Promise<repo.UserView>;
  deactivate(actorId: number, id: number): Promise<void>;
  changeRole(id: number, role: UserRole): Promise<repo.UserView>;
};

/**
 * Creates the users service.
 *
 * @param db - Database connected as docs_app.
 */
export function createUserService(db: Pick<Database, 'base' | 'prisma' | 'auditedTransaction'>): UserService {
  /** Locks, reads and applies the reserved-account guard; `change` then decides inside the same transaction. */
  const changeExisting = <T>(
    id: number,
    change: (tx: repo.UsersClient, current: repo.UserView) => Promise<T>,
  ): Promise<T> =>
    db.auditedTransaction(async (tx) => {
      await repo.lockTargetAndActiveAdmins(tx, id);
      const current = await repo.findUserById(tx, id);
      if (!current) throw E.notFound(ELEMENT, id);
      if (isIntegrationEmail(current.email)) throw E.reservedAccount();
      return change(tx, current);
    });

  /** The user would stop being an active administrator and nobody else is one. */
  const assertNotLastAdmin = async (tx: repo.UsersClient, current: repo.UserView): Promise<void> => {
    if (current.role === 'ADMINISTRATOR' && current.status === 'ACTIVE') {
      if ((await repo.countOtherActiveAdmins(tx, current.id)) === 0) throw E.lastActiveAdmin();
    }
  };

  return {
    async list(input) {
      const [data, total] = await repo.listUsers(db.base, { ...input, reservedEmail: security.integrationUserEmail });
      return { data, total };
    },

    async create(input) {
      const passwordHash = await hashPassword(input.password);
      // EMAIL_TAKEN comes from the unique constraint (race-safe) and is translated by the errorHandler.
      return db.prisma.user.create({
        data: { name: input.name, email: input.email.toLowerCase(), passwordHash, role: input.role },
        select: USER_VIEW_SELECT,
      });
    },

    async get(id) {
      const user = await repo.findUserById(db.base, id);
      // CP-06: the reserved account answers as if it did not exist.
      if (!user || isIntegrationEmail(user.email)) throw E.notFound(ELEMENT, id);
      return user;
    },

    async update(actorId, id, input, assertCurrent) {
      const passwordHash = input.password === undefined ? undefined : await hashPassword(input.password);
      return changeExisting(id, async (tx, current) => {
        assertCurrent(etagOf(current));
        const deactivating = current.status === 'ACTIVE' && input.status === 'INACTIVE';
        if (deactivating) {
          if (id === actorId) throw E.cannotDeactivateSelf();
          await assertNotLastAdmin(tx, current);
        }
        const updated = await repo.updateUser(tx, id, {
          name: input.name,
          email: input.email.toLowerCase(),
          status: input.status,
          ...(passwordHash === undefined ? {} : { passwordHash }),
        });
        if (deactivating || passwordHash !== undefined) await repo.revokeUserSessions(tx, id, new Date());
        return updated;
      });
    },

    async deactivate(actorId, id) {
      await changeExisting(id, async (tx, current) => {
        if (current.status === 'INACTIVE') return; // idempotent (D-09)
        if (id === actorId) throw E.cannotDeactivateSelf();
        await assertNotLastAdmin(tx, current);
        await repo.updateUser(tx, id, { status: 'INACTIVE' });
        await repo.revokeUserSessions(tx, id, new Date());
      });
    },

    async changeRole(id, role) {
      return changeExisting(id, async (tx, current) => {
        if (current.role === role) return current; // nothing changes, nothing is revoked
        if (role !== 'ADMINISTRATOR') await assertNotLastAdmin(tx, current);
        const updated = await repo.updateUser(tx, id, { role });
        await repo.revokeUserSessions(tx, id, new Date());
        return updated;
      });
    },
  };
}
