/** authenticate -> authorize(operationId). Role and status are read from the database on every request (SDD D-25). */
import type { ErrorRequestHandler, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { verifyAccessToken } from './tokens.js';
import { ApiError, E } from './errors.js';
import { security } from './config.js';
import { auditContext } from '../db/prisma.js';
import { asyncHandler } from '../http/asyncHandler.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { OperationPolicy } from './rbac.js';

/** Only the `user` delegate is needed to authenticate; pass the NON-extended client (`createPrisma().base`). */
export type AuthDb = Pick<PrismaClient, 'user'>;

export function authenticate(base: AuthDb): RequestHandler {
  return asyncHandler(async (req, _res, next) => {
    const header = req.get('authorization') ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) throw E.unauthenticated();
    let claims;
    try {
      claims = verifyAccessToken(token);
    } catch (e) {
      throw e instanceof jwt.TokenExpiredError ? E.tokenExpired() : E.unauthenticated();
    }
    const user = await base.user.findUnique({
      where: { id: Number(claims.sub) },
      select: { id: true, role: true, status: true },
    });
    if (!user || user.status !== 'ACTIVE') throw E.unauthenticated(); // deactivation is immediate
    req.user = user;
    auditContext.run({ userId: user.id }, next); // rule R-1: handlers run inside
  });
}

/** Role gate from the contract. Data rules (x-rule) are applied by services; SELF_OR_ROLE is checked here. */
export function authorize(policy: OperationPolicy): RequestHandler {
  return (req, _res, next) => {
    req.policy = policy;
    const role = req.user?.role;
    if (policy.roles.some((r) => r === role)) return next();
    if (policy.rule === 'SELF_OR_ROLE' && req.user && Number(req.params.id) === req.user.id) return next();
    next(E.forbidden(policy.roles));
  };
}

/** Cookie-authenticated endpoints (refresh, logout) accept only the frontend's Origin (CSRF defense with SameSite=Strict). */
export const requireAllowedOrigin: RequestHandler = (req, _res, next) =>
  req.get('origin') === security.allowedOrigin ? next() : next(E.originRejected());

/**
 * Minimal error handler of the Phase 2 harness (src/security/testApp.ts, test 07). The real application uses
 * `createErrorHandler` (src/http/errorHandler.ts), which translates every error class.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ApiError) {
    res.status(err.status).json({ code: err.code, message: err.message, details: err.details });
    return;
  }
  const requestId = randomUUID().slice(0, 8);
  console.error(requestId, err);
  const e = E.internal(requestId);
  res.status(e.status).json({ code: e.code, message: e.message, details: e.details });
};
