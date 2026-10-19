/**
 * Application rules (FR-27, NFR-16; SDD Table 47, D-03, D-28, D-47, D-62, D-63).
 *
 * Applications are archived (status ARCHIVED), never deleted. `create` and `update` run in one `auditedTransaction`.
 * `update` locks the row first (FOR UPDATE) and checks, in this order: 404, If-Match (412) and then the write, where
 * a repeated name (409 DUPLICATE_NAME, D-63) comes from the unique constraint and is translated by the errorHandler.
 * The contract defines no 422 for applications. The service never sees req/res.
 *
 * Other modules protect their writes with `assertApplicationActive` (D-42, D-47).
 *
 * @module modules/applications/service
 */
import type { Database } from '../../db/prisma.js';
import type { ApplicationStatus } from '../../generated/prisma/client.js';
import { etagOf } from '../../http/etag.js';
import { assertIdInRange } from '../../http/ids.js';
import { E } from '../../security/errors.js';
import * as repo from './repository.js';

/** Noun of the resource in messages. */
const ELEMENT = 'application';

/** Throws the 412 when the supplied `If-Match` differs from the ETag read inside the transaction. */
export type PreconditionCheck = (currentETag: string) => void;

/** Filters of the listing, already parsed by the controller. */
export type ListApplicationsInput = {
  q?: string | undefined;
  status?: ApplicationStatus | undefined;
  skip: number;
  take: number;
};

/** Body of `POST /applications`. */
export type CreateApplicationInput = {
  name: string;
  description?: string | null;
  platform: string;
  jiraProjectKey?: string | null;
};

/** Body of `PUT /applications/{id}`: full replacement. An omitted `description` or `jiraProjectKey` becomes null. */
export type UpdateApplicationInput = CreateApplicationInput & { status: ApplicationStatus };

/**
 * Guard of the archived application (CP-01, D-47): throws unless the application exists and is ACTIVE.
 *
 * MUST be called, inside the transaction that writes (`auditedTransaction`) and BEFORE the write, by every service
 * that writes variables, collections, screens (including their documentation status), review decisions, Jira
 * tickets and comments. Reports are exempt (D-47): they only read, so generating and downloading them stays allowed
 * on an archived application. `PUT /applications/{id}` is the only write accepted on an archived application and
 * does not call it.
 *
 * The status is read with a SHARE lock held until the transaction ends, so a concurrent archiving (`PUT`, which takes
 * FOR UPDATE) waits for the write in progress, and a write that starts after the archiving commits sees ARCHIVED.
 * Other modules reach it through the applications service (D-42).
 *
 * @param tx - Transaction client of `auditedTransaction`.
 * @param applicationId - Application the write belongs to.
 * @throws {ApiError} 404 NOT_FOUND when the application does not exist; 422 APPLICATION_ARCHIVED (with
 *   `details.applicationId`) when it is archived.
 */
export async function assertApplicationActive(
  tx: Pick<repo.ApplicationsClient, '$queryRaw'>,
  applicationId: number,
): Promise<void> {
  assertIdInRange(applicationId, ELEMENT);
  const status = await repo.lockApplicationStatusShared(tx, applicationId);
  if (status === null) throw E.notFound(ELEMENT, applicationId);
  if (status === 'ARCHIVED') throw E.applicationArchived(applicationId);
}

/** The applications service. */
export type ApplicationService = {
  list(input: ListApplicationsInput): Promise<{ data: repo.ApplicationView[]; total: number }>;
  create(actorId: number, input: CreateApplicationInput): Promise<repo.ApplicationView>;
  get(id: number): Promise<repo.ApplicationView>;
  update(id: number, input: UpdateApplicationInput, assertCurrent: PreconditionCheck): Promise<repo.ApplicationView>;
  /** See {@link assertApplicationActive}. */
  assertApplicationActive: typeof assertApplicationActive;
};

/**
 * Creates the applications service.
 *
 * @param db - Database connected as docs_app.
 */
export function createApplicationService(
  db: Pick<Database, 'base' | 'prisma' | 'auditedTransaction'>,
): ApplicationService {
  const read = async (client: repo.ApplicationsClient, id: number): Promise<repo.ApplicationView> => {
    const application = await repo.findApplicationById(client, id);
    if (!application) throw E.notFound(ELEMENT, id);
    return application;
  };

  return {
    async list(input) {
      const [data, total] = await repo.listApplications(db.base, input);
      return { data, total };
    },

    create(actorId, input) {
      // The trigger creates the App (OnStart) screen in the same transaction, so it is read back before commit.
      return db.auditedTransaction(async (tx) => {
        const id = await repo.createApplication(tx, {
          name: input.name,
          description: input.description ?? null,
          platform: input.platform,
          jiraProjectKey: input.jiraProjectKey ?? null,
          createdById: actorId,
        });
        return read(tx, id);
      });
    },

    get: (id) => read(db.base, id),

    update(id, input, assertCurrent) {
      return db.auditedTransaction(async (tx) => {
        await repo.lockApplicationForUpdate(tx, id);
        const current = await read(tx, id);
        assertCurrent(etagOf(current));
        await repo.updateApplication(tx, id, {
          name: input.name,
          description: input.description ?? null,
          platform: input.platform,
          jiraProjectKey: input.jiraProjectKey ?? null,
          status: input.status,
        });
        return read(tx, id);
      });
    },

    assertApplicationActive,
  };
}
