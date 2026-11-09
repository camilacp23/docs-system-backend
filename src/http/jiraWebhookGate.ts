/**
 * The first thing that touches the Jira webhook (SDD 7.2.8, Table 53 step 1; D-96). It is mounted in `app.ts` BEFORE
 * `express.json`, on the same path and by the same router as the operation, so upper/lower case and a trailing "/"
 * match both or neither: no other middleware can read the body first. It reads the RAW body (up to 1 MB), verifies
 * `X-Hub-Signature` and answers 401 INVALID_SIGNATURE otherwise. Once it has read the body, the JSON parser skips it.
 *
 * Nothing sensitive is logged: only the reason, never the signature, the secret, the body or a header.
 *
 * @module http/jiraWebhookGate
 */
import express, { type RequestHandler } from 'express';
import { verifyJiraSignature } from '../integrations/jira/verifySignature.js';
import { E } from '../security/errors.js';
import type { Logger } from './logger.js';

/** Maximum body of the Jira webhook (raw). */
const RAW_BODY_LIMIT = '1mb';

/**
 * Builds the gate.
 *
 * @param secret - `JIRA_WEBHOOK_SECRET`; undefined when not configured (every delivery is then 401).
 * @param logger - Application logger.
 * @returns The middlewares, in order: raw body, signature.
 */
export function jiraWebhookGate(secret: string | undefined, logger: Pick<Logger, 'warn'>): RequestHandler[] {
  const verify: RequestHandler = (req, _res, next) => {
    if (secret === undefined || secret === '') {
      logger.warn({ operation: 'receiveJiraWebhook', reason: 'SECRET_NOT_CONFIGURED' }, 'webhook delivery rejected');
      next(E.invalidSignature());
      return;
    }
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifyJiraSignature(body, req.get('x-hub-signature'), secret)) {
      logger.warn({ operation: 'receiveJiraWebhook', reason: 'SIGNATURE_MISMATCH' }, 'webhook delivery rejected');
      next(E.invalidSignature());
      return;
    }
    next();
  };
  return [express.raw({ type: () => true, limit: RAW_BODY_LIMIT }), verify];
}
