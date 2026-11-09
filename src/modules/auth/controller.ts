/**
 * HTTP layer of the authentication module: reads the body and the `rt` cookie, calls the service and writes the
 * response and the cookie. No rules here. The Origin check of refresh and logout runs before (http/operations.ts).
 *
 * @module modules/auth/controller
 */
import type { CookieOptions, Request, Response } from 'express';
import { security } from '../../security/config.js';
import type { AuthService, SessionResult } from './service.js';

type LoginBody = { email: string; password: string };

/** Cookie attributes of `rt`: unreadable by scripts, HTTPS only, same-site only, scoped to /api/v1/auth (SDD Table 65). */
const baseCookie = (): CookieOptions => ({
  httpOnly: true,
  secure: true,
  sameSite: 'strict',
  path: security.refreshCookie.path,
});

const rawCookie = (req: Request): string | undefined => {
  const value: unknown = (req.cookies as Record<string, unknown> | undefined)?.[security.refreshCookie.name];
  return typeof value === 'string' && value !== '' ? value : undefined;
};

/** Writes the 200 of login and refresh: the cookie dies with the session, the tokens never get cached. */
function sendSession(res: Response, s: SessionResult): void {
  res.cookie(security.refreshCookie.name, s.refreshToken, { ...baseCookie(), expires: s.sessionExpiresAt });
  res.set('Cache-Control', 'no-store');
  res.json({
    data: {
      accessToken: s.accessToken,
      tokenType: 'Bearer',
      expiresIn: s.expiresIn,
      sessionExpiresIn: s.sessionExpiresIn,
      user: s.user,
    },
  });
}

/**
 * Creates the handlers of the three /auth operations.
 *
 * @param service - Authentication service.
 */
export function createAuthController(service: AuthService) {
  return {
    /** POST /auth/login */
    login: async (req: Request, res: Response): Promise<void> => {
      const { email, password } = req.body as LoginBody;
      sendSession(res, await service.login(email, password));
    },
    /** POST /auth/refresh */
    refresh: async (req: Request, res: Response): Promise<void> => {
      sendSession(res, await service.refresh(rawCookie(req)));
    },
    /** POST /auth/logout */
    logout: async (req: Request, res: Response): Promise<void> => {
      await service.logout(rawCookie(req));
      res.clearCookie(security.refreshCookie.name, baseCookie());
      res.set('Cache-Control', 'no-store');
      res.status(204).end();
    },
  };
}
