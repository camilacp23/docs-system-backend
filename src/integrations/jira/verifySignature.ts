/**
 * Verifies a Jira Cloud admin-webhook delivery (X-Hub-Signature, WebSub format).
 * Jira signs the RAW request body with HMAC using the webhook secret and sends
 * `method=signature`, currently `sha256=<hex>`. Must run before JSON parsing:
 * in Express, mount the route with express.raw({ type: 'application/json', limit: '1mb' }).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const SUPPORTED = new Set(['sha256']);

export function verifyJiraSignature(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  const sep = header.indexOf('=');
  if (sep < 1) return false;
  const method = header.slice(0, sep).toLowerCase();
  const given = header.slice(sep + 1);
  if (!SUPPORTED.has(method) || !/^[0-9a-f]+$/i.test(given)) return false; // Atlassian may add methods later
  const expected = createHmac(method, secret).update(rawBody).digest();
  const received = Buffer.from(given, 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}
