/**
 * Representation of the audit history (FR-20, FR-21; contract `AuditEntry` and `ActivitySummary`).
 *
 * The database stores column names (`documentation_status`); the API serves camelCase (SDD 7.1). Only the first-level
 * keys of `oldValue` and `newValue` and the items of `changedFields` are translated. The values are never touched,
 * including the content of JSON columns such as `report.parameters`. Everything here is a pure function.
 *
 * @module modules/audit/representation
 */

/** A first-level key (or a field name) in snake_case becomes camelCase; a name that has no underscore is unchanged. */
export function toCamelCase(name: string): string {
  return name.replace(/_+([a-zA-Z0-9])/g, (_match, char: string) => char.toUpperCase());
}

/** A stored image of a row: a JSON object. */
export type StoredValue = Record<string, unknown>;

const isObject = (value: unknown): value is StoredValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The table whose rows carry a redacted column, and the key that must never be served. */
const REDACTED_KEY = 'passwordHash';
const REDACTED_ENTITY = 'app_user';

/**
 * Translates the first-level keys of a stored image. Nested values are returned as they are.
 *
 * @param value - `old_value` or `new_value` as stored (an object, or null).
 * @param entityType - Table of the record: for `app_user` the key `passwordHash` is dropped (safety net: the trigger
 * already redacts the value, and the contract says a redacted column has no key).
 * @returns The image with camelCase keys, or null.
 */
export function translateValue(value: unknown, entityType?: string): StoredValue | null {
  if (!isObject(value)) return null;
  const out: StoredValue = {};
  for (const [key, inner] of Object.entries(value)) {
    const camel = toCamelCase(key);
    if (camel === REDACTED_KEY && entityType === REDACTED_ENTITY) continue;
    out[camel] = inner;
  }
  return out;
}

/** One row of `audit_log` joined with its actor, as the repository reads it. */
export type AuditRow = {
  id: bigint | string | number;
  action: string;
  eventName: string | null;
  entityType: string;
  entityId: string;
  entityLabel: string | null;
  applicationId: number | null;
  actorId: number | null;
  actorName: string | null;
  dbRole: string;
  changedFields: string[] | null;
  oldValue: unknown;
  newValue: unknown;
  createdAt: Date;
};

/** `{ id, name }`, or null for a write that did not come from the API. */
export type ActorRef = { id: number; name: string } | null;

const actorOf = (row: AuditRow): ActorRef =>
  row.actorId === null ? null : { id: row.actorId, name: row.actorName ?? '' };

/** An audit record as the API serves it. `dbRole` exists only for the Administrator. */
export type AuditEntry = {
  id: string;
  action: string;
  eventName: string | null;
  entityType: string;
  entityId: string;
  entityLabel: string | null;
  applicationId: number | null;
  actor: ActorRef;
  dbRole?: string;
  changedFields: string[];
  oldValue: StoredValue | null;
  newValue: StoredValue | null;
  createdAt: string;
};

/**
 * Builds the `AuditEntry` of a row.
 *
 * @param row - Row of `audit_log` with its actor.
 * @param includeDbRole - True for the Administrator; for anyone else the key is omitted (never null).
 */
export function toAuditEntry(row: AuditRow, includeDbRole: boolean): AuditEntry {
  return {
    id: String(row.id),
    action: row.action,
    eventName: row.eventName,
    entityType: row.entityType,
    entityId: row.entityId,
    entityLabel: row.entityLabel,
    applicationId: row.applicationId,
    actor: actorOf(row),
    ...(includeDbRole ? { dbRole: row.dbRole } : {}),
    changedFields: (row.changedFields ?? []).map(toCamelCase),
    oldValue: translateValue(row.oldValue, row.entityType),
    newValue: translateValue(row.newValue, row.entityType),
    createdAt: row.createdAt.toISOString(),
  };
}

/** A record without its values or its database role (contract `ActivitySummary`). */
export type ActivitySummary = {
  actor: ActorRef;
  action: string;
  eventName: string | null;
  entityType: string;
  entityId: string;
  entityLabel: string | null;
  createdAt: string;
};

/** Builds the `ActivitySummary` of a row: nothing else of the row is copied. */
export function toActivitySummary(row: AuditRow): ActivitySummary {
  return {
    actor: actorOf(row),
    action: row.action,
    eventName: row.eventName,
    entityType: row.entityType,
    entityId: row.entityId,
    entityLabel: row.entityLabel,
    createdAt: row.createdAt.toISOString(),
  };
}
