/**
 * Rules of the advanced search (FR-17, FR-18; D-105). Read only. The service never sees req/res.
 *
 * Order of the answers: the role gate (x-roles) and the contract validator run before this code, so a missing
 * `applicationId` or a malformed parameter is 400 first. Here the rules that need the trimmed text come next (400),
 * then the range of the application id and its existence (404), and only then the result.
 *
 * @module modules/search/service
 */
import { assertIdInRange } from '../../http/ids.js';
import { E } from '../../security/errors.js';
import { toSearchResult, type SearchResult } from './representation.js';
import type { ElementType, SearchRepository } from './repository.js';
import { normalizeText } from './text.js';

/** Every type, in the order of the contract. */
export const ELEMENT_TYPES: readonly ElementType[] = ['SCREEN', 'VARIABLE', 'COLLECTION', 'COMPONENT'];

/** The shortest `q`, in characters, once trimmed (D-105 a). */
export const MIN_QUERY_LENGTH = 2;

/** The parameters of `GET /search`, already parsed by the controller. */
export type SearchInput = {
  applicationId: number;
  q?: string | undefined;
  types?: readonly ElementType[] | undefined;
  environment?: string | undefined;
  documentationStatus?: string | undefined;
  scope?: string | undefined;
  skip: number;
  take: number;
};

/** A page of results and the number of elements that match. */
export type SearchResults = { data: SearchResult[]; total: number };

/** The search service. */
export type SearchService = {
  /** `GET /search`. */
  search(input: SearchInput): Promise<SearchResults>;
};

/**
 * Creates the search service.
 *
 * @param repository - Read-only queries of the module.
 */
export function createSearchService(repository: SearchRepository): SearchService {
  return {
    async search(input) {
      const trimmed = input.q?.trim();
      // Characters, not UTF-16 units: an emoji is one, like in the validator.
      if (trimmed !== undefined && [...trimmed].length < MIN_QUERY_LENGTH) {
        throw E.validation([{ field: 'q', rule: 'minLength', message: 'must NOT have fewer than 2 characters' }]);
      }
      const hasFilter = [input.types, input.environment, input.documentationStatus, input.scope].some(
        (filter) => filter !== undefined,
      );
      if (trimmed === undefined && !hasFilter) {
        throw E.validation([{ field: 'q', rule: 'required', message: 'This value is required.' }]);
      }
      assertIdInRange(input.applicationId, 'application');

      const query = trimmed === undefined ? undefined : normalizeText(trimmed);
      const types = ELEMENT_TYPES.filter((type) => input.types === undefined || input.types.includes(type));
      const page = await repository.readPage(
        {
          applicationId: input.applicationId,
          query,
          types,
          environment: input.environment,
          documentationStatus: input.documentationStatus,
          scope: input.scope,
        },
        input.skip,
        input.take,
      );
      if (page === null) throw E.notFound('application', input.applicationId);
      return { data: page.rows.map((row) => toSearchResult(row, query)), total: page.total };
    },
  };
}
