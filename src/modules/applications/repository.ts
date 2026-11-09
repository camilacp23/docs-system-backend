/**
 * Prisma queries of the applications module. No rules live here (SDD Table 6, D-42): the service decides, this only
 * reads and writes. `appContextScreen` is not a column: it is the screen of the application flagged `is_app_context`
 * (created by the database trigger), read here and joined to the row.
 *
 * @module modules/applications/repository
 */
import type { ApplicationStatus, Prisma, PrismaClient } from '../../generated/prisma/client.js';
import { escapeLike } from '../../http/like.js';

/** Clients accepted by the queries: the plain client or the transaction client of `auditedTransaction`. */
export type ApplicationsClient = Pick<PrismaClient, 'application' | 'screen' | '$queryRaw'>;

/** Reference to another resource (contract schema `Ref`). */
export type Ref = { id: number; name: string };

/** The application as the API returns it (contract schema `Application`). */
export type ApplicationView = {
  id: number;
  name: string;
  description: string | null;
  platform: string;
  jiraProjectKey: string | null;
  status: ApplicationStatus;
  appContextScreen: Ref;
  createdBy: Ref;
  createdAt: Date;
  updatedAt: Date;
};

/** Editable columns of an application (contract schemas `ApplicationWrite` + `status`). */
export type ApplicationData = {
  name: string;
  description: string | null;
  platform: string;
  jiraProjectKey: string | null;
  status: ApplicationStatus;
};

/** Filters of `GET /applications`. The order is fixed: name ascending, id as tie-breaker. */
export type ApplicationListQuery = {
  q?: string | undefined;
  status?: ApplicationStatus | undefined;
  skip: number;
  take: number;
};

const ROW_SELECT = {
  id: true,
  name: true,
  description: true,
  platform: true,
  jiraProjectKey: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  createdBy: { select: { id: true, name: true } },
} as const;

type Row = Prisma.ApplicationGetPayload<{ select: typeof ROW_SELECT }>;

/** Screens flagged App (OnStart), by application id. Every application has exactly one (database trigger). */
async function appContextScreens(client: ApplicationsClient, applicationIds: number[]): Promise<Map<number, Ref>> {
  if (applicationIds.length === 0) return new Map();
  const screens = await client.screen.findMany({
    where: { applicationId: { in: applicationIds }, isAppContext: true },
    select: { id: true, name: true, applicationId: true },
  });
  return new Map(screens.map((s) => [s.applicationId, { id: s.id, name: s.name }]));
}

function toView(row: Row, screens: Map<number, Ref>): ApplicationView {
  const appContextScreen = screens.get(row.id);
  // The trigger creates it in the same statement as the application: its absence is a defect, not a user error.
  if (!appContextScreen) throw new Error(`application ${row.id} has no App (OnStart) screen`);
  return { ...row, appContextScreen };
}

/** A page of applications and the total that matches the filters. */
export async function listApplications(
  client: ApplicationsClient,
  query: ApplicationListQuery,
): Promise<[ApplicationView[], number]> {
  const q = query.q === undefined ? undefined : escapeLike(query.q);
  const where: Prisma.ApplicationWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}),
  };
  const [rows, total] = await Promise.all([
    client.application.findMany({
      where,
      select: ROW_SELECT,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      skip: query.skip,
      take: query.take,
    }),
    client.application.count({ where }),
  ]);
  const screens = await appContextScreens(
    client,
    rows.map((r) => r.id),
  );
  return [rows.map((r) => toView(r, screens)), total];
}

/** Reads one application. */
export async function findApplicationById(client: ApplicationsClient, id: number): Promise<ApplicationView | null> {
  const row = await client.application.findUnique({ where: { id }, select: ROW_SELECT });
  return row ? toView(row, await appContextScreens(client, [id])) : null;
}

/** Inserts an application; the database trigger creates its App (OnStart) screen in the same statement. */
export async function createApplication(
  client: ApplicationsClient,
  data: Omit<ApplicationData, 'status'> & { createdById: number },
): Promise<number> {
  const row = await client.application.create({ data, select: { id: true } });
  return row.id;
}

/** Replaces the editable columns of an application. */
export async function updateApplication(client: ApplicationsClient, id: number, data: ApplicationData): Promise<void> {
  await client.application.update({ where: { id }, data });
}

/** Locks the row for update (PUT). Blocks, and is blocked by, `lockApplicationStatusShared`. */
export async function lockApplicationForUpdate(
  client: Pick<ApplicationsClient, '$queryRaw'>,
  id: number,
): Promise<void> {
  await client.$queryRaw`SELECT id FROM application WHERE id = ${id} FOR UPDATE`;
}

/**
 * Reads the status of an application holding a SHARE lock until the end of the transaction, so a concurrent archiving
 * (which takes FOR UPDATE) waits for the writer, and a writer that starts later sees the committed status.
 *
 * @returns The status, or `null` when the application does not exist.
 */
export async function lockApplicationStatusShared(
  client: Pick<ApplicationsClient, '$queryRaw'>,
  id: number,
): Promise<ApplicationStatus | null> {
  const rows = await client.$queryRaw<{ status: ApplicationStatus }[]>`
    SELECT status FROM application WHERE id = ${id} FOR SHARE`;
  return rows[0]?.status ?? null;
}
