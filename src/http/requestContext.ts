/**
 * Request identifier and access log. Every response carries `X-Request-Id`; the same id is in the log line and in
 * the body of an INTERNAL_ERROR, so a user's reference can be found in the logs.
 *
 * @module http/requestContext
 */
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { pinoHttp } from 'pino-http';
import type { Logger } from './logger.js';

/** A client-supplied X-Request-Id is kept only if it is short and harmless (no log injection). */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Builds the request-id and access-log middleware.
 *
 * @param logger - Application logger.
 * @returns A middleware that sets `req.id`, the `X-Request-Id` header and `req.log`.
 */
export function requestContext(logger: Logger): RequestHandler {
  return pinoHttp({
    logger,
    genReqId: (req, res) => {
      const supplied = req.headers['x-request-id'];
      const id = typeof supplied === 'string' && SAFE_REQUEST_ID.test(supplied) ? supplied : randomUUID().slice(0, 12);
      res.setHeader('X-Request-Id', id);
      return id;
    },
    customLogLevel: (_req, res, err) =>
      err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
    // Only what is needed to follow a request: no headers, no body, no query string (it may carry search text).
    serializers: {
      req: (req: { id: unknown; method?: string; url?: string }) => ({
        id: req.id,
        method: req.method,
        url: req.url?.split('?')[0],
      }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
  });
}
