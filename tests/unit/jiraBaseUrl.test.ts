/** Restriction of the Jira base URL (NFR-04): HTTPS, or HTTP only for the local simulator. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertJiraBaseUrl, isLocalJiraBaseUrl, jiraBaseUrlProblem } from '../../src/integrations/jira/baseUrl.js';

describe('jiraBaseUrlProblem', () => {
  it('accepts https for any host', () => {
    assert.equal(jiraBaseUrlProblem('https://site.atlassian.net'), null);
    assert.equal(jiraBaseUrlProblem('https://localhost:8443', { production: true }), null);
  });

  it('accepts http only for localhost and 127.0.0.1', () => {
    assert.equal(jiraBaseUrlProblem('http://localhost:3002'), null);
    assert.equal(jiraBaseUrlProblem('http://127.0.0.1:3002'), null);
    for (const bad of [
      'http://site.atlassian.net',
      'http://localhost.evil.example',
      'http://evil.example/localhost',
      'http://127.0.0.2',
      'http://[::1]:3002',
      'http://0.0.0.0:3002',
    ]) {
      assert.notEqual(jiraBaseUrlProblem(bad), null, bad);
    }
  });

  it('refuses plain http in production, even for localhost', () => {
    assert.match(jiraBaseUrlProblem('http://localhost:3002', { production: true }) ?? '', /production/);
  });

  it('refuses other schemes, credentials, query strings and text that is not a URL', () => {
    for (const bad of ['ftp://site.atlassian.net', 'https://u:p@site.atlassian.net', 'https://s.net/?a=1', 'x', '']) {
      assert.notEqual(jiraBaseUrlProblem(bad), null, bad);
    }
  });

  it('never repeats the URL in the reason', () => {
    const reason = jiraBaseUrlProblem('http://secret-host.example') ?? '';
    assert.doesNotMatch(reason, /secret-host/);
  });
});

describe('assertJiraBaseUrl / isLocalJiraBaseUrl', () => {
  it('returns the URL without a trailing slash, or throws without the URL in the message', () => {
    assert.equal(assertJiraBaseUrl('https://site.atlassian.net/'), 'https://site.atlassian.net');
    assert.throws(
      () => assertJiraBaseUrl('http://secret-host.example'),
      (e: Error) => !/secret-host/.test(e.message),
    );
  });

  it('recognizes local hosts only', () => {
    assert.equal(isLocalJiraBaseUrl('http://localhost:1'), true);
    assert.equal(isLocalJiraBaseUrl('https://127.0.0.1:1'), true);
    assert.equal(isLocalJiraBaseUrl('https://site.atlassian.net'), false);
    assert.equal(isLocalJiraBaseUrl('nope'), false);
  });
});
