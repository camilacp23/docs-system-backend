/** Tests never reach the real Jira: a non-local JIRA_BASE_URL is refused before anything starts. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { startTestApp } from '../helpers/app.js';
import { assertJiraConfigIsLocal, assertLocalJiraBaseUrl } from '../helpers/jiraGuard.js';

describe('Jira safeguard', () => {
  it('accepts no URL, localhost and 127.0.0.1', () => {
    for (const ok of [undefined, '', 'http://localhost:3002', 'http://127.0.0.1:1'])
      assert.doesNotThrow(() => assertLocalJiraBaseUrl(ok, 'x'));
    assert.doesNotThrow(() => assertJiraConfigIsLocal({}, 'x'));
  });

  it('refuses any other host and never repeats the URL', () => {
    for (const bad of ['https://site.atlassian.net', 'http://localhost.evil.example', 'http://10.0.0.5', 'nonsense']) {
      assert.throws(
        () => assertLocalJiraBaseUrl(bad, 'test application'),
        (e: Error) => /must point to localhost/.test(e.message) && !e.message.includes(bad),
      );
    }
    assert.throws(() => assertJiraConfigIsLocal({ baseUrl: 'https://site.atlassian.net' }, 'x'));
  });

  it('startTestApp refuses a real Jira URL before it creates a database', async () => {
    await assert.rejects(startTestApp({ env: { JIRA_BASE_URL: 'https://site.atlassian.net' } }), /localhost/);
  });
});
