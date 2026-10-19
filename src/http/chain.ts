/**
 * Horizontal middleware of the SDD Figure 3 that has no business rules: security headers, CORS, request
 * validation against the contract, and the mount point of the /auth rate limit.
 *
 * @module http/chain
 */
import cors from 'cors';
import type { RequestHandler } from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import helmet from 'helmet';
import type { AppConfig } from '../config/env.js';

/** Helmet for a JSON API: nothing may be loaded or framed from a response (CSP default-src 'none'). */
export function securityHeaders(): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
  });
}

/**
 * CORS with an exact allowlist: the only Origin is FRONTEND_ORIGIN. Any other Origin receives no CORS headers.
 *
 * @param config - Uses `frontendOrigin`.
 */
export function corsPolicy(config: Pick<AppConfig, 'frontendOrigin'>): RequestHandler {
  return cors({
    origin: (origin, callback) => {
      callback(null, origin === config.frontendOrigin);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'If-Match'],
    exposedHeaders: ['ETag', 'Location', 'Retry-After', 'X-Request-Id'],
    maxAge: 600,
    optionsSuccessStatus: 204,
  });
}

/**
 * Request validation against the contract, same configuration as the verified test 08. It is mounted PER
 * OPERATION (see operations.ts), after authentication and authorization, so 401/403 come before 400.
 *
 * @param openapiPath - Path of `api/openapi.yaml`.
 * @returns The validator's middleware chain.
 */
export function requestValidator(openapiPath: string): RequestHandler[] {
  return OpenApiValidator.middleware({
    apiSpec: openapiPath,
    // Same as test 08 (the defaults of `true`) plus allErrors: details.fields lists every invalid field, not the first.
    validateRequests: { allowUnknownQueryParameters: false, coerceTypes: false, allErrors: true },
    validateResponses: false,
    validateSecurity: false,
    ignoreUndocumented: false,
    serDes: [],
    $refParser: { mode: 'dereference' },
  });
}
