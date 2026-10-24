/**
 * Translation of database errors into the API error format (SDD Section 7.1 note on Table 45, D-62 to D-65).
 *
 * Shape of the errors, inspected on Prisma 7.10 with @prisma/adapter-pg:
 * - `PrismaClientKnownRequestError` (P2002, P2003, P2010, P2025, P2039...) carries the PostgreSQL error in
 *   `meta.driverAdapterError.cause` (`originalCode` = SQLSTATE, `constraint.index` for UNIQUE/FK, `detail`...).
 * - A deferred trigger that fails at COMMIT arrives as a bare `DriverAdapterError` with the same `cause`.
 * - CHECK and trigger errors do NOT carry the constraint name (only the localized message mentions a CHECK), so
 *   the name is looked for in the message among the names of `dbRules.ts`, and the integrity triggers are
 *   recognized by the literal text of their RAISE. A constraint name or SQLSTATE always wins over the text.
 *
 * @module http/dbErrors
 */
import type { Request } from 'express';
import { ApiError, E } from '../security/errors.js';
import type { Database } from '../db/prisma.js';
import { KNOWN_CONSTRAINTS, ruleFor, type ConstraintRule } from './dbRules.js';
import { elementOfPath } from './ids.js';

/** What the errorHandler needs to know about a database error, independent of the wrapper that carried it. */
export type DbFacts = {
  /** Prisma error code (P2002...), when the error came wrapped by Prisma Client. */
  prismaCode?: string;
  /** PostgreSQL SQLSTATE (23505...). */
  sqlstate?: string;
  constraint?: string;
  table?: string;
  /** Message of PostgreSQL (localized for built-in errors, literal for the project's RAISE). */
  message?: string;
  detail?: string;
  modelName?: string;
};

/** Result of translating a database error. */
export type DbOutcome =
  | { kind: 'api'; error: ApiError }
  /** A defect (or an error nobody can fix from the client): the handler answers 500 and logs `reason`. */
  | { kind: 'internal'; reason: string; todo?: string };

export type TranslationContext = {
  req: Request;
  res: { locals: Record<string, unknown> };
  db: Pick<Database, 'base'>;
};

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

const nameIn = (message: string, name: string): boolean =>
  new RegExp(`(^|[^a-z0-9_])${name}($|[^a-z0-9_])`).test(message);

/**
 * Normalizes any database error into `DbFacts`.
 *
 * @param err - The thrown value.
 * @returns The facts, or `null` when the value is not a database error.
 */
export function extractDbFacts(err: unknown): DbFacts | null {
  if (!isRecord(err)) return null;
  const facts: DbFacts = {};
  let cause: Rec | undefined;

  if (err.name === 'PrismaClientKnownRequestError' && typeof err.code === 'string') {
    facts.prismaCode = err.code;
    const meta = isRecord(err.meta) ? err.meta : {};
    const model = asString(meta.modelName);
    if (model !== undefined) facts.modelName = model;
    const adapterError = isRecord(meta.driverAdapterError) ? meta.driverAdapterError : {};
    if (isRecord(adapterError.cause)) cause = adapterError.cause;
  } else if (err.name === 'DriverAdapterError' && isRecord(err.cause)) {
    cause = err.cause;
  } else if (typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code) && typeof err.severity === 'string') {
    cause = err; // a raw `pg` DatabaseError
  } else {
    return null;
  }

  if (cause !== undefined) {
    const sqlstate = asString(cause.originalCode) ?? asString(cause.code);
    if (sqlstate !== undefined) facts.sqlstate = sqlstate;
    const message = asString(cause.originalMessage) ?? asString(cause.message);
    if (message !== undefined) facts.message = message;
    const constraint = isRecord(cause.constraint) ? asString(cause.constraint.index) : asString(cause.constraint);
    if (constraint !== undefined) facts.constraint = constraint;
    const table = asString(cause.table);
    if (table !== undefined) facts.table = table;
    const detail = asString(cause.detail);
    if (detail !== undefined) facts.detail = detail;
  }
  if (facts.constraint === undefined && facts.message !== undefined) {
    const found = KNOWN_CONSTRAINTS.find((name) => nameIn(facts.message ?? '', name));
    if (found !== undefined) facts.constraint = found;
  }
  return facts.prismaCode === undefined && facts.sqlstate === undefined ? null : facts;
}

/** Integrity triggers raise errors without a constraint name; they are recognized by the literal RAISE text. */
function ruleByText(facts: DbFacts): ConstraintRule | undefined {
  const m = facts.message ?? '';
  switch (facts.sqlstate) {
    case '23514':
      if (m.startsWith('CONTEXT_SCREEN_MISMATCH:')) return { kind: 'contextScreenMismatch' };
      if (m.startsWith('Cross-application link rejected on')) return { kind: 'crossApplication' };
      if (/^Element \d+ must exist in at least one environment/.test(m)) {
        return {
          kind: 'validation',
          field: 'environments',
          rule: 'CHECK',
          message: 'Select at least one environment (DEV or PROD).',
        };
      }
      return undefined;
    case '23000':
      if (m === 'The App (OnStart) screen cannot be deleted') return { kind: 'appContextProtected' };
      if (m === 'is_app_context cannot be changed') return { kind: 'internal', reason: 'APP_CONTEXT_FLAG' };
      return undefined;
    case '23503':
      if (/^documented_element \d+ \(/.test(m)) return { kind: 'internal', reason: 'ELEMENT_WITHOUT_SUBTYPE' };
      return undefined;
    default:
      return undefined;
  }
}

/** `UserRole`-style Prisma model name to a lowercase noun: `JiraTicket` -> `jira ticket`. */
const modelElement = (modelName: string): string => modelName.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

const positiveInt = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;

function requestParts(ctx: TranslationContext) {
  const body: Rec = isRecord(ctx.req.body) ? ctx.req.body : {};
  const pathParams: Rec = isRecord(ctx.res.locals.pathParams) ? ctx.res.locals.pathParams : {};
  const idParam = asString(pathParams.id);
  const paramId = idParam !== undefined && /^\d+$/.test(idParam) ? Number(idParam) : undefined;
  return { body, paramId, operationId: ctx.req.policy?.operationId, contractPath: ctx.req.policy?.path };
}

async function applicationName(ctx: TranslationContext): Promise<string | undefined> {
  const { body, paramId } = requestParts(ctx);
  const applicationId = positiveInt(body.applicationId);
  if (applicationId !== undefined) {
    return (await ctx.db.base.application.findUnique({ where: { id: applicationId }, select: { name: true } }))?.name;
  }
  if (paramId !== undefined) {
    const element = await ctx.db.base.documentedElement.findUnique({
      where: { id: paramId },
      select: { application: { select: { name: true } } },
    });
    return element?.application.name;
  }
  return undefined;
}

async function screenNames(ctx: TranslationContext, ids: number[]): Promise<Map<number, string>> {
  const rows = await ctx.db.base.screen.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function duplicateName(
  rule: Extract<ConstraintRule, { kind: 'duplicateName' }>,
  ctx: TranslationContext,
): Promise<DbOutcome> {
  const { body } = requestParts(ctx);
  const name = asString(body.name);
  if (name === undefined) return { kind: 'internal', reason: 'DUPLICATE_NAME_WITHOUT_NAME' };
  let scope: string | undefined;
  if (rule.container === 'system') scope = 'Documentación técnica';
  else if (rule.container === 'application') scope = await applicationName(ctx);
  else {
    const originScreenId = positiveInt(body.originScreenId);
    scope = originScreenId === undefined ? undefined : (await screenNames(ctx, [originScreenId])).get(originScreenId);
  }
  if (scope === undefined) return { kind: 'internal', reason: 'DUPLICATE_NAME_SCOPE_NOT_FOUND' };
  return { kind: 'api', error: E.duplicateName(rule.type, name, scope, rule.container) };
}

async function contextScreenMismatch(facts: DbFacts, ctx: TranslationContext): Promise<DbOutcome> {
  let detail: unknown;
  try {
    detail = JSON.parse(facts.detail ?? '');
  } catch {
    return { kind: 'internal', reason: 'CONTEXT_SCREEN_MISMATCH_DETAIL' };
  }
  if (!isRecord(detail)) return { kind: 'internal', reason: 'CONTEXT_SCREEN_MISMATCH_DETAIL' };
  const variableId = positiveInt(detail.variableId);
  const screenId = positiveInt(detail.screenId);
  const variable = asString(detail.variableName);
  const originScreenId = positiveInt(detail.originScreenId) ?? null;
  if (variableId === undefined || screenId === undefined || variable === undefined) {
    return { kind: 'internal', reason: 'CONTEXT_SCREEN_MISMATCH_DETAIL' };
  }
  const names = await screenNames(ctx, originScreenId === null ? [screenId] : [originScreenId, screenId]);
  const originScreen = originScreenId === null ? null : (names.get(originScreenId) ?? null);
  return {
    kind: 'api',
    error: E.contextScreenMismatch({
      variableId,
      variable,
      originScreenId: originScreen === null ? null : originScreenId,
      originScreen,
      screenId,
      targetScreen: names.get(screenId) ?? `screen ${screenId}`,
    }),
  };
}

async function applyRule(rule: ConstraintRule, facts: DbFacts, ctx: TranslationContext): Promise<DbOutcome> {
  const { body, paramId, operationId } = requestParts(ctx);
  const api = (error: ApiError): DbOutcome => ({ kind: 'api', error });
  switch (rule.kind) {
    case 'emailTaken':
      return api(E.emailTaken());
    case 'duplicateName':
      return duplicateName(rule, ctx);
    case 'validation':
      return api(E.validation([{ field: rule.field, rule: rule.rule, message: rule.message }]));
    case 'operationValidation': {
      const array = operationId === undefined ? undefined : rule.fields[operationId];
      if (array === undefined) return { kind: 'internal', reason: rule.reason };
      const items = Array.isArray(body[array]) ? (body[array] as unknown[]) : [];
      // The database does not say which item it was: for a self-reference it is the id of the resource itself.
      const position = paramId === undefined ? -1 : items.indexOf(paramId);
      const field = position < 0 ? `${array}[]` : `${array}[${position}]`;
      return api(E.validation([{ field, rule: 'self', message: rule.message }]));
    }
    case 'notFound':
      return api(E.notFound((operationId !== undefined ? rule.byOperation?.[operationId] : undefined) ?? rule.element));
    case 'scope': {
      if (operationId === 'updateVariable') {
        // D-62/P5: the scope is changing while incompatible assignments exist; the function names the conflict.
        if (body.scope === 'CONTEXT') return api(E.scopeConflict('Set'));
        if (body.scope === 'GLOBAL') return api(E.scopeConflict('UpdateContext'));
      }
      const onCollection = operationId === 'createCollection' || operationId === 'updateCollection';
      return api(E.scopeMismatch(onCollection ? 'variableAssignments[].assignmentFunction' : undefined));
    }
    case 'reportNotReady': {
      const report =
        paramId === undefined
          ? null
          : await ctx.db.base.report.findUnique({ where: { id: paramId }, select: { status: true } });
      return api(E.reportNotReady(report?.status ?? 'UNKNOWN'));
    }
    case 'storyNotInScreen': {
      const storyId = positiveInt(body.storyId);
      return storyId === undefined
        ? { kind: 'internal', reason: 'STORY_NOT_IN_SCREEN_WITHOUT_ID' }
        : api(E.storyNotInScreen(storyId));
    }
    case 'contextScreenMismatch':
      return contextScreenMismatch(facts, ctx);
    case 'crossApplication':
      return api(E.crossApplication());
    case 'appContextProtected':
      return api(E.appContextProtected());
    case 'internal':
      return rule.todo === undefined
        ? { kind: 'internal', reason: rule.reason }
        : { kind: 'internal', reason: rule.reason, todo: rule.todo };
  }
}

/**
 * Translates a database error.
 *
 * @param facts - Normalized error (`extractDbFacts`).
 * @param ctx - Request context (body, path params, operation) and a read-only database handle for names.
 * @returns An API error, or `internal` when the error is a defect that must be answered as 500.
 */
export async function translateDbError(facts: DbFacts, ctx: TranslationContext): Promise<DbOutcome> {
  const rule = ruleFor(facts.constraint) ?? ruleByText(facts);
  if (rule !== undefined) return applyRule(rule, facts, ctx);

  const { paramId, contractPath } = requestParts(ctx);
  // A record that does not exist (update/delete by id) or an id outside the integer range.
  if (facts.prismaCode === 'P2025' || facts.prismaCode === 'P2020' || facts.sqlstate === '22003') {
    const element = facts.modelName !== undefined ? modelElement(facts.modelName) : elementOfPath(contractPath);
    return { kind: 'api', error: E.notFound(element, paramId) };
  }
  const detail = facts.constraint ?? facts.prismaCode ?? 'unknown';
  return { kind: 'internal', reason: `DB_${facts.sqlstate ?? 'ERROR'}_${detail}` };
}
