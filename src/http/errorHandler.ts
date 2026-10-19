/**
 * errorHandler of the real application: every error leaves as `{ code, message, details }` with the exact messages
 * of the catalog (SDD Tables 45 and 59). Nothing internal (stack, SQL, Prisma text) reaches the client.
 *
 * @module http/errorHandler
 */
import type { ErrorRequestHandler, Request, RequestHandler, Response } from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import { ApiError, E, type FieldError } from '../security/errors.js';
import type { Database } from '../db/prisma.js';
import { extractDbFacts, translateDbError, type DbFacts } from './dbErrors.js';
import type { Logger } from './logger.js';

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Id assigned by the request middleware (also sent as X-Request-Id). */
export const requestIdOf = (req: Request): string => (typeof req.id === 'string' ? req.id : 'unknown');

/**
 * Writes the error body without Express's automatic ETag: an ETag on an error would be a validator of nothing.
 */
function sendError(res: Response, status: number, body: { code: string; message: string; details: unknown }): void {
  res.status(status).type('json').end(JSON.stringify(body));
}

/** Handler of the requests no route of the contract answered (unknown path or method). */
export const routeNotFound: RequestHandler = (_req, _res, next) => {
  next(E.routeNotFound());
};

/** `.body.items.0.name` / `/body/items/0/name` -> `items[0].name`; a body-level error -> `body`. */
function fieldOf(path: unknown): string {
  const cleaned = (typeof path === 'string' ? path : '').replace(/\//g, '.').replace(/^\.+/, '');
  const m = /^(body|query|params|headers|cookies)(?:\.(.*))?$/.exec(cleaned);
  const rest = m ? (m[2] ?? '') : cleaned;
  const field = rest === '' ? (m?.[1] ?? 'body') : rest;
  return field.replace(/\.(\d+)(?=\.|$)/g, '[$1]');
}

function fieldsFromValidator(errors: unknown): FieldError[] {
  if (!Array.isArray(errors)) return [];
  return errors.filter(isRecord).map((e) => ({
    field: fieldOf(e.path),
    rule: (typeof e.errorCode === 'string' ? e.errorCode : 'invalid').split('.')[0] ?? 'invalid',
    message: typeof e.message === 'string' ? e.message : 'This value is not valid.',
  }));
}

/** Errors thrown by body-parser (express.json / express.raw): the `type` is stable, the message is not. */
function fromBodyParser(err: Rec): ApiError | undefined {
  if (typeof err.type !== 'string' || typeof err.status !== 'number') return undefined;
  if (err.type === 'entity.too.large') return E.payloadTooLarge();
  if (err.type === 'entity.parse.failed') {
    return E.validation([{ field: 'body', rule: 'json', message: 'The request body is not valid JSON.' }]);
  }
  if (/^(encoding|charset|request|stream|entity)\./.test(err.type)) {
    return E.validation([{ field: 'body', rule: err.type, message: 'The request body could not be read.' }]);
  }
  return undefined;
}

function fromValidator(err: unknown): ApiError | undefined {
  if (err instanceof OpenApiValidator.error.BadRequest) return E.validation(fieldsFromValidator(err.errors));
  if (err instanceof OpenApiValidator.error.UnsupportedMediaType) {
    return E.validation([{ field: 'Content-Type', rule: 'mediaType', message: 'Send the body as application/json.' }]);
  }
  if (err instanceof OpenApiValidator.error.NotFound || err instanceof OpenApiValidator.error.MethodNotAllowed) {
    return E.routeNotFound();
  }
  return undefined;
}

/** What is written to the log for an error: Prisma messages embed the query arguments, so they are not logged. */
function describeForLog(err: unknown, facts: DbFacts | null): Rec {
  if (facts !== null) {
    return {
      type: 'DatabaseError',
      prismaCode: facts.prismaCode,
      sqlstate: facts.sqlstate,
      constraint: facts.constraint,
      table: facts.table,
      model: facts.modelName,
    };
  }
  if (err instanceof ApiError) return { type: 'ApiError', code: err.code };
  if (err instanceof Error) {
    return err.name.startsWith('PrismaClient')
      ? { type: err.name }
      : { type: err.name, message: err.message, stack: err.stack };
  }
  return { type: typeof err };
}

type Classified = { error: ApiError; log?: { level: 'warn' | 'error'; extra: Rec } };

async function classify(err: unknown, req: Request, res: Response, db: Pick<Database, 'base'>): Promise<Classified> {
  if (err instanceof ApiError) {
    return err.status >= 500
      ? { error: err, log: { level: 'warn', extra: describeForLog(err, null) } }
      : { error: err };
  }
  if (isRecord(err)) {
    const parsed = fromBodyParser(err);
    if (parsed !== undefined) return { error: parsed };
  }
  const validation = fromValidator(err);
  if (validation !== undefined) return { error: validation };

  const facts = extractDbFacts(err);
  if (facts !== null) {
    const outcome = await translateDbError(facts, { req, res, db });
    if (outcome.kind === 'api') return { error: outcome.error };
    const extra: Rec = { ...describeForLog(err, facts), reason: outcome.reason };
    if (outcome.todo !== undefined) extra.todo = outcome.todo;
    return { error: E.internal(requestIdOf(req)), log: { level: 'error', extra } };
  }
  return { error: E.internal(requestIdOf(req)), log: { level: 'error', extra: describeForLog(err, null) } };
}

/**
 * Creates the final error handler.
 *
 * @param deps - `db.base` is used only for read-only lookups of names that complete a message.
 * @returns An Express error handler.
 */
export function createErrorHandler(deps: { db: Pick<Database, 'base'>; logger: Logger }): ErrorRequestHandler {
  const respond = async (err: unknown, req: Request, res: Response): Promise<void> => {
    let classified: Classified;
    try {
      classified = await classify(err, req, res, deps.db);
    } catch (translationError) {
      // The translation itself failed (for example a lookup): never leave the request without an answer.
      classified = {
        error: E.internal(requestIdOf(req)),
        log: { level: 'error', extra: { ...describeForLog(translationError, null), while: 'translating an error' } },
      };
    }
    if (classified.log !== undefined) {
      const log = typeof req.log?.[classified.log.level] === 'function' ? req.log : deps.logger;
      log[classified.log.level]({ requestId: requestIdOf(req), ...classified.log.extra }, 'request failed');
    }
    const { status, code, message, details } = classified.error;
    sendError(res, status, { code, message, details });
  };

  return (err, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    respond(err, req, res).catch(() => {
      const { status, code, message, details } = E.internal(requestIdOf(req));
      sendError(res, status, { code, message, details });
    });
  };
}
