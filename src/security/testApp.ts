/**
 * Test harness: an Express app that mounts ALL operations of the OpenAPI contract
 * with the real authentication/authorization chain. Session, role change and
 * deactivation have real handlers; the other operations are stubs that answer
 * 200 { operationId } once authorization has passed.
 * 0.3.0 (CP-06, CP-08): the user operations also simulate the reserved integration
 * account (hidden from GET /users, 404 on GET /users/{id}, 422 RESERVED_ACCOUNT on
 * changes), and PUT /screens/{id} answers 422 SCREEN_IN_REVIEW for a screen in review.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { security } from './config.js';
import { loadPolicies } from './rbac.js';
import { authenticate, authorize, requireAllowedOrigin, errorHandler } from './middleware.js';
import { createAuthService } from './authService.js';
import { E } from './errors.js';
import { assertEditable } from '../modules/screens/documentationWorkflow.js';

export function buildApp(db: { prisma: any; base: any }, openapiPath: string) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  const auth = createAuthService(db);
  const policies = loadPolicies(openapiPath);
  const cookieOpts = { httpOnly: true, secure: true, sameSite: 'strict' as const, path: security.refreshCookie.path };
  const loginLimiter = rateLimit({
    windowMs: security.loginRateLimit.windowMs, limit: security.loginRateLimit.maxFailures, skipSuccessfulRequests: true,
    keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? '')}:${String(req.body?.email ?? '').toLowerCase()}`,
    handler: (_req, res) => {
      const e = E.rateLimited(security.loginRateLimit.windowMs / 60000);
      res.status(e.status).json({ code: e.code, message: e.message, details: e.details });
    },
  });
  /** CP-06: id of the reserved integration account (null if it was not seeded). */
  const reservedId = async (): Promise<number | null> =>
    (await db.base.user.findUnique({ where: { email: security.integrationUserEmail }, select: { id: true } }))?.id ?? null;
  const isReserved = async (id: unknown) => Number(id) === (await reservedId());
  const stub = (operationId: string): express.RequestHandler => (_req, res) => { res.json({ operationId }); };
  const session = (res: express.Response, s: any) => {
    res.cookie(security.refreshCookie.name, s.refreshToken, { ...cookieOpts, expires: s.sessionExpiresAt });   // cookie dies with the session
    res.json({ data: { accessToken: s.accessToken, tokenType: 'Bearer', expiresIn: security.accessTtlSeconds, user: s.user } });
  };
  const handlers: Record<string, express.RequestHandler> = {
    login: async (req, res, next) => { try { session(res, await auth.login(String(req.body?.email ?? ''), String(req.body?.password ?? ''))); } catch (e) { next(e); } },
    refreshSession: async (req, res, next) => { try { session(res, await auth.refresh(req.cookies?.rt)); } catch (e) { next(e); } },
    logout: async (req, res, next) => { try { await auth.logout(req.cookies?.rt); res.clearCookie('rt', { path: security.refreshCookie.path }); res.status(204).end(); } catch (e) { next(e); } },
    listUsers: async (req, res, next) => {
      try {
        const page = Number(req.query.page ?? 1), pageSize = Number(req.query.pageSize ?? 20);
        const where = { email: { not: security.integrationUserEmail } };             // CP-06: never listed
        const [rows, total] = await Promise.all([
          db.base.user.findMany({ where, orderBy: { name: 'asc' }, skip: (page - 1) * pageSize, take: pageSize,
            select: { id: true, name: true, email: true, role: true, status: true, lastLoginAt: true, createdAt: true, updatedAt: true } }),
          db.base.user.count({ where }),
        ]);
        res.json({ data: rows, page, pageSize, total });
      } catch (e) { next(e); }
    },
    getUser: async (req, res, next) => {
      try {
        if (await isReserved(req.params.id)) throw E.notFound('user', Number(req.params.id));   // CP-06: as if it did not exist
        stub('getUser')(req, res, next);
      } catch (e) { next(e); }
    },
    updateUser: async (req, res, next) => {
      try {
        if (await isReserved(req.params.id)) throw E.reservedAccount();
        stub('updateUser')(req, res, next);
      } catch (e) { next(e); }
    },
    updateScreen: async (req, res, next) => {
      try {
        const screen = await db.base.screen.findUnique({ where: { id: Number(req.params.id) }, select: { documentationStatus: true } });
        if (screen) assertEditable(screen.documentationStatus);                       // CP-08
        stub('updateScreen')(req, res, next);
      } catch (e) { next(e); }
    },
    changeUserRole: async (req, res, next) => {
      try {
        if (await isReserved(req.params.id)) throw E.reservedAccount();
        const u = await db.prisma.user.update({ where: { id: Number(req.params.id) }, data: { role: req.body.role } });
        await auth.revokeAllSessions(u.id);
        res.json({ data: { id: u.id, role: u.role } });
      } catch (e) { next(e); }
    },
    deactivateUser: async (req, res, next) => {
      try {
        if (await isReserved(req.params.id)) throw E.reservedAccount();
        if (Number(req.params.id) === req.user!.id) throw E.cannotDeactivateSelf();
        await db.prisma.user.update({ where: { id: Number(req.params.id) }, data: { status: 'INACTIVE' } });
        await auth.revokeAllSessions(Number(req.params.id));
        res.status(204).end();
      } catch (e) { next(e); }
    },
  };
  for (const p of policies.values()) {
    const chain: express.RequestHandler[] = [];
    if (p.operationId === 'login') chain.push(loginLimiter);
    else if (p.operationId === 'refreshSession' || p.operationId === 'logout') chain.push(requireAllowedOrigin);
    else if (p.rule === 'JIRA_SIGNATURE') chain.push((_req, res) => { res.status(501).end(); });   // covered by tests J0-J8
    else chain.push(authenticate(db.base), authorize(p));
    chain.push(handlers[p.operationId] ?? stub(p.operationId));
    (app as any)[p.method.toLowerCase()](p.expressPath, ...chain);
  }
  app.use(errorHandler);
  return { app, policies };
}
