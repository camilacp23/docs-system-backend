/**
 * Rate limits of /api/v1/auth (NFR-05). Each operation has its own counter, so abusing refresh can never block
 * logout, which is what revokes a session.
 *
 * - login: 5 failed attempts per IP + e-mail in 15 minutes (SDD Table 64, D-27). Successful logins are not counted.
 * - refresh and logout (D-60): RATE_LIMIT_SESSION_MAX requests per RATE_LIMIT_SESSION_WINDOW_MINUTES, per IP + a
 *   SHA-256 fingerprint of the `rt` cookie (IP only without cookie), so one office behind a NAT is not locked out.
 *
 * The 429 goes through the errorHandler (RATE_LIMITED with `details.minutes`). `Retry-After` (seconds) and
 * `details.minutes` come from the same calculation: minutes = ceil(seconds / 60), at least 1.
 *
 * Counters live in memory, per process (one API instance). A shared store is needed before running several.
 *
 * @module http/rateLimit
 */
import { createHash } from 'node:crypto';
import { Router, type Request, type RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit, type Options, type RateLimitInfo } from 'express-rate-limit';
import type { AppConfig } from '../config/env.js';
import { E } from '../security/errors.js';
import { security } from '../security/config.js';

/** Failures allowed for one IP + e-mail in the login window. */
const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MINUTES = 15;
const MAX_EMAIL_KEY_LENGTH = 254;
const COOKIE_FINGERPRINT_HEX = 16;

/**
 * Seconds until the window of a limited request reopens, and the same time in minutes for the message.
 *
 * @param resetTime - When the counter resets (undefined falls back to the full window).
 * @param windowMs - Window length.
 * @param now - Current time (tests).
 */
export function retryAfter(
  resetTime: Date | undefined,
  windowMs: number,
  now: number = Date.now(),
): { seconds: number; minutes: number } {
  const ms = resetTime ? resetTime.getTime() - now : windowMs;
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  return { seconds, minutes: Math.max(1, Math.ceil(seconds / 60)) };
}

const limited: Options['handler'] = (req, res, next, options) => {
  const { seconds, minutes } = retryAfter(
    (req as Request & { rateLimit?: RateLimitInfo }).rateLimit?.resetTime,
    options.windowMs,
  );
  res.setHeader('Retry-After', String(seconds));
  next(E.rateLimited(minutes));
};

const emailOf = (req: Request): string => {
  const email: unknown = (req.body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' ? email.trim().toLowerCase().slice(0, MAX_EMAIL_KEY_LENGTH) : '';
};

const cookieFingerprint = (req: Request): string => {
  const value: unknown = (req.cookies as Record<string, unknown> | undefined)?.[security.refreshCookie.name];
  return typeof value === 'string' && value !== ''
    ? createHash('sha256').update(value).digest('hex').slice(0, COOKIE_FINGERPRINT_HEX)
    : '';
};

const common = { standardHeaders: false, legacyHeaders: false, handler: limited } as const;

/** Limit of POST /auth/login: failures per IP + e-mail. */
export function loginRateLimit(): RequestHandler {
  return rateLimit({
    ...common,
    windowMs: LOGIN_WINDOW_MINUTES * 60_000,
    limit: LOGIN_MAX_FAILURES,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? '')}:${emailOf(req)}`,
  });
}

/** Limit of POST /auth/refresh or /auth/logout (D-60): one instance per operation, so each has its own counter. */
export function sessionRateLimit(config: Pick<AppConfig, 'rateLimitSessionMax' | 'rateLimitSessionWindowMinutes'>) {
  return rateLimit({
    ...common,
    windowMs: config.rateLimitSessionWindowMinutes * 60_000,
    limit: config.rateLimitSessionMax,
    keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? '')}:${cookieFingerprint(req)}`,
  });
}

/**
 * Router mounted on /api/v1/auth (src/app.ts): it limits the three operations and lets everything else through.
 *
 * @param config - D-60 values.
 */
export function authRateLimit(
  config: Pick<AppConfig, 'rateLimitSessionMax' | 'rateLimitSessionWindowMinutes'>,
): RequestHandler {
  const router = Router();
  router.post('/login', loginRateLimit());
  router.post('/refresh', sessionRateLimit(config));
  router.post('/logout', sessionRateLimit(config));
  return router;
}
