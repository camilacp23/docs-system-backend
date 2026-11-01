/**
 * Screen rules. Only the listing exists so far (B-09; FR-10, FR-14, FR-19, SDD Table 50, D-14, D-70). The service
 * also lets other modules validate a reference to a screen without touching this module's tables (D-42).
 *
 * @module modules/screens/service
 */
import type { Database } from '../../db/prisma.js';
import type { DocumentationStatus } from '../../generated/prisma/client.js';
import { INT32_MAX, assertIdInRange } from '../../http/ids.js';
import type { ApplicationService } from '../applications/service.js';
import * as repo from './repository.js';

/** Filters of the listing, already parsed by the controller. */
export type ListScreensInput = {
  applicationId: number;
  q?: string | undefined;
  documentationStatus?: DocumentationStatus | undefined;
  authorId?: number | undefined;
  sort: repo.ScreenListQuery['sort'];
  skip: number;
  take: number;
};

/**
 * The read-only lookup other modules use to validate a reference to a screen (D-80). It is separate from the full
 * service so Variables and Collections can be built before it without a circular dependency.
 */
export type ScreenLookup = {
  /** The screen a client points at, or `null` when it does not exist or its id cannot exist. */
  findRef(client: Pick<repo.ScreensClient, 'screen'>, id: number): Promise<repo.ScreenRef | null>;
};

/** The screens service. */
export type ScreenService = ScreenLookup & {
  list(input: ListScreensInput): Promise<{ data: repo.ScreenSummaryView[]; total: number }>;
};

/** Creates the read-only screen lookup (D-80): it never writes and needs no database handle of its own. */
export function createScreenLookup(): ScreenLookup {
  return { findRef: (client, id) => (id > INT32_MAX ? Promise.resolve(null) : repo.findScreenRef(client, id)) };
}

/**
 * Creates the screens service.
 *
 * @param db - Database connected as docs_app.
 * @param applications - Applications service (the parent of a listing must exist).
 */
export function createScreenService(
  db: Pick<Database, 'base'>,
  applications: Pick<ApplicationService, 'get'>,
): ScreenService {
  const lookup = createScreenLookup();
  return {
    async list(input) {
      // D-70: the parent application must exist (404); an id used as a filter that cannot match gives an empty page.
      assertIdInRange(input.applicationId, 'application');
      await applications.get(input.applicationId);
      if (input.authorId !== undefined && input.authorId > INT32_MAX) return { data: [], total: 0 };
      const [data, total] = await repo.listScreens(db.base, input);
      return { data, total };
    },

    findRef: (client, id) => lookup.findRef(client, id),
  };
}
