/** The Jira client never writes the token, the Authorization header, the e-mail or the webhook secret (NFR-06). */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import type { JiraConfig } from '../../src/config/env.js';
import { createLogger } from '../../src/http/logger.js';
import { createJiraClient, type JiraError } from '../../src/integrations/jira/index.js';

const TOKEN = 'TOKEN-SECRET-123';
const EMAIL = 'tech.account@example.org';
const WEBHOOK_SECRET = 'WEBHOOK-SECRET-456';
const JIRA: JiraConfig = {
  baseUrl: 'https://private-site.atlassian.net',
  email: EMAIL,
  apiToken: TOKEN,
  projectKey: 'TECHEA',
  issueTypeEpicId: '10000',
  issueTypeStoryId: '10001',
  issueTypeSubtaskId: '10002',
  webhookSecret: WEBHOOK_SECRET,
};
const BASIC = Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const screen = { screenId: 1, screenName: 'Login', applicationName: 'SAR' };

beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 }));
afterEach(() => mock.timers.reset());

describe('Jira client logging', () => {
  it('writes nothing secret on any outcome, in the log or in the error messages', async () => {
    const lines: string[] = [];
    const logger = createLogger({ logLevel: 'debug', nodeEnv: 'test' }, { write: (l: string) => void lines.push(l) });
    const messages: string[] = [];
    const replies = [
      () => new Response(null, { status: 500 }),
      () => new Response(null, { status: 401 }),
      () => new Response(null, { status: 403 }),
      () => new Response(null, { status: 429, headers: { 'retry-after': '1' } }),
      () => new Response(JSON.stringify({ errorMessages: ['nope'] }), { status: 404 }),
      () => Promise.reject(new TypeError('fetch failed')),
      () => new Response('<html></html>', { status: 200 }),
    ];
    let n = 0;
    const fetchFn = ((): Promise<Response> => Promise.resolve(replies[n++ % replies.length]!())) as typeof fetch;
    const client = createJiraClient(JIRA, { fetch: fetchFn, logger });
    for (let i = 0; i < 30; i++) {
      const p = (
        i % 2 === 0 ? client.getIssue('TECHEA-1') : client.createIssue({ level: 'EPIC', summary: 's', screen })
      ).catch((e: unknown) => messages.push((e as JiraError).message));
      for (let k = 0; k < 20; k++) {
        await flush();
        mock.timers.runAll();
      }
      await p;
      mock.timers.tick(60_000);
    }
    const out = lines.join('\n');
    assert.ok(lines.length > 0, 'the client logged something');
    assert.match(out, /jira circuit opened/);
    const everything = `${out}\n${messages.join('\n')}`;
    for (const secret of [
      TOKEN,
      EMAIL,
      WEBHOOK_SECRET,
      BASIC,
      'Basic ',
      'Authorization',
      'authorization',
      'private-site',
    ]) {
      assert.equal(everything.includes(secret), false, `leaked: ${secret.slice(0, 5)}...`);
    }
  });

  it('redacts a Jira configuration object that someone logs by mistake', () => {
    const lines: string[] = [];
    const logger = createLogger({ logLevel: 'info', nodeEnv: 'test' }, { write: (l: string) => void lines.push(l) });
    logger.info({
      apiToken: TOKEN,
      webhookSecret: WEBHOOK_SECRET,
      jira: { apiToken: TOKEN, webhookSecret: WEBHOOK_SECRET },
    });
    logger.info({ headers: { authorization: `Basic ${BASIC}`, 'x-hub-signature': 'sha256=abc' } });
    const out = lines.join('');
    for (const secret of [TOKEN, WEBHOOK_SECRET, BASIC, 'sha256=abc'])
      assert.equal(out.includes(secret), false, secret);
  });
});
