/**
 * Structured logging (Phase 3 decision "Logging"): `pino` in JSON, with the secrets of a request redacted.
 * `pino-pretty` (a dev dependency) is used only when NODE_ENV=development, never in production.
 *
 * @module http/logger
 */
import pino, { type DestinationStream, type Logger } from 'pino';
import type { AppConfig } from '../config/env.js';

export type { Logger } from 'pino';

/** Keys whose value is never written to a log (NFR-06; CLAUDE.md rule 7). */
export const REDACT_PATHS: readonly string[] = [
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  'passwordHash',
  'accessToken',
  'refreshToken',
  'apiToken',
  'webhookSecret',
  '*.authorization',
  '*.cookie',
  '*.set-cookie',
  '*.password',
  '*.passwordHash',
  '*.accessToken',
  '*.refreshToken',
  '*.apiToken',
  '*.webhookSecret',
  '*.x-hub-signature',
  'x-hub-signature',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-hub-signature"]',
  'res.headers["set-cookie"]',
  'req.body.password',
];

/**
 * Creates the application logger.
 *
 * @param config - Level and environment.
 * @param destination - Optional stream (tests capture the output); disables the development pretty printer.
 * @returns A pino logger with redaction.
 */
export function createLogger(config: Pick<AppConfig, 'logLevel' | 'nodeEnv'>, destination?: DestinationStream): Logger {
  const options: pino.LoggerOptions = {
    level: config.logLevel,
    redact: { paths: [...REDACT_PATHS], censor: '[Redacted]' },
  };
  if (destination !== undefined) return pino(options, destination);
  if (config.nodeEnv === 'development') {
    return pino({ ...options, transport: { target: 'pino-pretty', options: { colorize: true } } });
  }
  return pino(options);
}
