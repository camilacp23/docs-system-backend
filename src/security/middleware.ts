/** authenticate -> authorize(operationId). Role and status are read from the DB on every request (SDD D-25). */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { verifyAccessToken } from './tokens.js';
import { ApiError, E } from './errors.js';
import { security } from './config.js';
import { auditContext } from '../db/prisma.js';
import type { OperationPolicy } from './rbac.js';

declare global { namespace Express { interface Request { user?: { id: number; role: string; status: string }; policy?: OperationPolicy } } }

export function authenticate(base: any): RequestHandler {
  return async (req, _res, next) => {
    try {
      const header = req.get('authorization') ?? '';
      const [scheme, token] = header.split(' ');
      if (scheme !== 'Bearer' || !token) throw E.unauthenticated();
      let claims;
      try { claims = verifyAccessToken(token); }
      catch (e) { throw e instanceof jwt.TokenExpiredError ? E.tokenExpired() : E.unauthenticated(); }
      const user = await base.user.findUnique({ where: { id: Number(claims.sub) }, select: { id: true, role: true, status: true } });
      if (!user || user.status !== 'ACTIVE') throw E.unauthenticated();       // deactivation is immediate
      req.user = user;
      auditContext.run({ userId: user.id }, next);                           // rule R-1: handlers run inside
    } catch (e) { next(e); }
  };
}

/** Role gate from the contract. Data rules (x-rule) are applied by services; SELF_OR_ROLE is checked here. */
export function authorize(policy: OperationPolicy): RequestHandler {
  return (req, _res, next) => {
    req.policy = policy;
    const role = req.user?.role as any;
    if (policy.roles.includes(role)) return next();
    if (policy.rule === 'SELF_OR_ROLE' && req.user && Number(req.params.id) === req.user.id) return next();
    next(E.forbidden(policy.roles));
  };
}

/** Cookie-authenticated endpoints (refresh, logout) accept only the frontend's Origin (CSRF defense with SameSite=Strict). */
export const requireAllowedOrigin: RequestHandler = (req, _res, next) =>
  req.get('origin') === security.allowedOrigin ? next() : next(E.originRejected());

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) return res.status(err.status).json({ code: err.code, message: err.message, details: err.details });
  // Phase 3 (TODO_FASE3.md): translate database errors here, e.g. constraint
  // 'context_screen_mismatch' (CP-07) -> E.contextScreenMismatch(JSON.parse(err.detail)).
  const requestId = randomUUID().slice(0, 8);
  console.error(requestId, err);
  const e = E.internal(requestId);
  res.status(e.status).json({ code: e.code, message: e.message, details: e.details });
}
