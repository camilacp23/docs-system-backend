/**
 * The scope of a report (contract schema `ReportScope`, D-115) and the rules the service applies on top of the
 * contract validator: repeated values with their position, an empty `elementTypes` without the status summary, and
 * `screenIds` / `documentationStatus` without screens or components. Pure: no database, no HTTP.
 *
 * @module modules/reports/scope
 */
import { repeatedFields } from '../../http/repeats.js';
import type { FieldError } from '../../security/errors.js';

/** The four kinds of element a report can list (contract `ElementType`). */
export type ReportElementType = 'SCREEN' | 'VARIABLE' | 'COLLECTION' | 'COMPONENT';

/** The five documentation statuses (contract `DocumentationStatus`). */
export type ReportDocumentationStatus = 'UNDOCUMENTED' | 'DRAFT' | 'IN_PROGRESS' | 'IN_REVIEW' | 'APPROVED';

/** `scope` of the request, as the validator lets it through (only the keys the client sent). */
export type ReportScopeBody = {
  elementTypes: ReportElementType[];
  includeStatusSummary?: boolean;
  screenIds?: number[];
  documentationStatus?: ReportDocumentationStatus[];
  includeDependencies?: boolean;
};

/**
 * The 400 field errors of a scope, all together and in this order (the validator already lists all its errors the
 * same way): repeated values (`scope.elementTypes[i]`, `scope.screenIds[i]`, `scope.documentationStatus[i]`), then
 * `required` on `scope.elementTypes` and then `notApplicable` on `scope.screenIds` / `scope.documentationStatus`.
 *
 * @param scope - The scope of the request.
 * @returns The errors; empty when the scope is valid.
 */
export function scopeProblems(scope: ReportScopeBody): FieldError[] {
  const fields: FieldError[] = [
    ...repeatedFields(
      scope.elementTypes,
      (type) => type,
      (i) => `scope.elementTypes[${i}]`,
    ),
    ...repeatedFields(
      scope.screenIds ?? [],
      (id) => String(id),
      (i) => `scope.screenIds[${i}]`,
    ),
    ...repeatedFields(
      scope.documentationStatus ?? [],
      (status) => status,
      (i) => `scope.documentationStatus[${i}]`,
    ),
  ];
  if (scope.elementTypes.length === 0 && scope.includeStatusSummary !== true) {
    fields.push({ field: 'scope.elementTypes', rule: 'required', message: 'This value is required.' });
  }
  const hasScreens = scope.elementTypes.includes('SCREEN') || scope.elementTypes.includes('COMPONENT');
  if (!hasScreens) {
    for (const field of ['screenIds', 'documentationStatus'] as const) {
      if (scope[field] !== undefined) {
        fields.push({
          field: `scope.${field}`,
          rule: 'notApplicable',
          message: `scope.${field} only applies when SCREEN or COMPONENT is selected.`,
        });
      }
    }
  }
  return fields;
}
