/**
 * Mounts the operations of the OpenAPI contract (SDD Section 4.1, D-39, D-42).
 *
 * Every operation of `loadPolicies` becomes an Express route with this chain, in this order:
 * `authenticate -> authorize -> request validation -> id range -> handler`. So a missing token is 401 and a wrong
 * role is 403 before any 400. An operation without a module handler yet answers 404 NOT_FOUND with
 * `details.reason = "NOT_IMPLEMENTED"` AFTER authentication, authorization and validation.
 *
 * The four operations without user roles (`x-roles: []`) follow the public chain: login (validated body),
 * refresh and logout (cookie + exact Origin), and the Jira webhook (raw body and signature in `jiraWebhookGate`).
 * An operation with empty `x-roles` that is not one of those four stops the server from starting (fail closed).
 *
 * @module http/operations
 */
import type { Express, RequestHandler } from 'express';
import type { Database } from '../db/prisma.js';
import { authenticate, authorize, requireAllowedOrigin } from '../security/middleware.js';
import type { OperationPolicy } from '../security/rbac.js';
import { E } from '../security/errors.js';
import { asyncHandler, type AsyncRequestHandler } from './asyncHandler.js';
import { assertIdInRange, elementOfPath } from './ids.js';

/** Operations that have no user role: the only ones allowed to declare `x-roles: []`. */
export const PUBLIC_OPERATIONS: ReadonlySet<string> = new Set([
  'login',
  'refreshSession',
  'logout',
  'receiveJiraWebhook',
]);

/** Handlers by `operationId`; each module contributes its own (src/modules/index.ts). */
export type OperationHandlers = Readonly<Record<string, AsyncRequestHandler>>;

/** The server refuses to start: the contract or the module registry is inconsistent. */
export class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartupError';
  }
}

/**
 * Fails closed: an operation with empty roles must be a known public one, and every handler must belong to an
 * operation of the contract.
 *
 * @param policies - Policies generated from the contract.
 * @param handlers - Module handlers by operationId.
 * @throws {StartupError} When the registry is inconsistent.
 */
export function assertRegistry(policies: ReadonlyMap<string, OperationPolicy>, handlers: OperationHandlers): void {
  for (const p of policies.values()) {
    if (p.roles.length === 0 && !PUBLIC_OPERATIONS.has(p.operationId)) {
      throw new StartupError(`${p.operationId} declares empty x-roles but is not a public operation`);
    }
    if (p.roles.length > 0 && PUBLIC_OPERATIONS.has(p.operationId)) {
      throw new StartupError(`${p.operationId} is a public operation but declares x-roles`);
    }
  }
  for (const operationId of Object.keys(handlers)) {
    if (!policies.has(operationId))
      throw new StartupError(`handler "${operationId}" is not an operation of the contract`);
  }
}

/** Records the matched operation and its path parameters: the errorHandler runs outside the route and needs them. */
const bindOperation =
  (policy: OperationPolicy): RequestHandler =>
  (req, res, next) => {
    req.policy = policy;
    res.locals.pathParams = { ...req.params };
    next();
  };

/** D-62: an integer id beyond the range of the column cannot exist, so it is 404 without reaching Prisma. */
const checkIdRange =
  (policy: OperationPolicy): RequestHandler =>
  (req, _res, next) => {
    const id = req.params.id;
    if (id !== undefined) {
      const element = policy.path.startsWith('/dependencies/')
        ? String(req.params.type).toLowerCase()
        : elementOfPath(policy.path);
      assertIdInRange(id, element);
    }
    next();
  };

const notImplemented: RequestHandler = (_req, _res, next) => {
  next(E.notImplemented());
};

/**
 * Registers every operation of the contract on `app`.
 *
 * @param app - Express application.
 * @param deps - Policies, module handlers, the request validator and the database.
 * @returns The `operationId`s that have no handler yet (answered as NOT_IMPLEMENTED).
 */
export function registerOperations(
  app: Express,
  deps: {
    policies: ReadonlyMap<string, OperationPolicy>;
    handlers: OperationHandlers;
    validator: RequestHandler[];
    db: Pick<Database, 'base'>;
  },
): string[] {
  assertRegistry(deps.policies, deps.handlers);
  const pending: string[] = [];

  for (const policy of deps.policies.values()) {
    const chain: RequestHandler[] = [bindOperation(policy)];
    switch (policy.operationId) {
      case 'login':
        chain.push(...deps.validator);
        break;
      case 'refreshSession':
      case 'logout':
        chain.push(requireAllowedOrigin, ...deps.validator);
        break;
      case 'receiveJiraWebhook':
        // Nothing to add: the raw body and the signature were handled by `jiraWebhookGate`, mounted in app.ts
        // before any parser (SDD 7.2.8), so the module only receives a verified body.
        break;
      default:
        chain.push(authenticate(deps.db.base), authorize(policy), ...deps.validator, checkIdRange(policy));
    }

    const handler = deps.handlers[policy.operationId];
    if (handler === undefined) {
      pending.push(policy.operationId);
      chain.push(notImplemented);
    } else {
      chain.push(asyncHandler(handler));
    }

    switch (policy.method) {
      case 'GET':
        app.get(policy.expressPath, ...chain);
        break;
      case 'POST':
        app.post(policy.expressPath, ...chain);
        break;
      case 'PUT':
        app.put(policy.expressPath, ...chain);
        break;
      case 'DELETE':
        app.delete(policy.expressPath, ...chain);
        break;
      case 'PATCH':
        app.patch(policy.expressPath, ...chain);
        break;
    }
  }
  return pending;
}
