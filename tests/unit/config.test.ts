/** loadConfig: types, ranges and formats of every variable of .env.example. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { ConfigError, loadConfig } from '../../src/config/index.js';

const key = (bytes = 32): string => randomBytes(bytes).toString('base64');
const valid = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'development',
  APP_DATABASE_URL: 'postgresql://docs_app:secret@localhost:5432/docs_system',
  JWT_KEYS: `k1:${key()}`,
  FRONTEND_ORIGIN: 'http://localhost:5173',
  INTEGRATION_USER_EMAIL: 'Integracion.Jira@System.Local',
});

const problemsOf = (env: NodeJS.ProcessEnv): string[] => {
  try {
    loadConfig(env);
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    return e.problems;
  }
  return assert.fail('loadConfig should have thrown');
};

describe('loadConfig', () => {
  it('applies the documented defaults', () => {
    const c = loadConfig(valid());
    assert.equal(c.port, 3000);
    assert.equal(c.logLevel, 'info');
    assert.equal(c.trustProxy, false);
    assert.equal(c.jwtAccessTtlSeconds, 28_800);
    assert.equal(c.sessionMaxSeconds, 43_200);
    assert.equal(c.bcryptCost, 12);
    assert.equal(c.rateLimitSessionMax, 30);
    assert.equal(c.rateLimitSessionWindowMinutes, 15);
    assert.equal(c.integrationUserEmail, 'integracion.jira@system.local');
    assert.deepEqual(c.jira, {});
  });

  it('reports every problem at once and never prints a value', () => {
    const problems = problemsOf({ NODE_ENV: 'prod', PORT: '99999', APP_DATABASE_URL: 'not a url', JWT_KEYS: 'x' });
    const text = problems.join('\n');
    for (const name of [
      'NODE_ENV',
      'PORT',
      'APP_DATABASE_URL',
      'JWT_KEYS',
      'FRONTEND_ORIGIN',
      'INTEGRATION_USER_EMAIL',
    ]) {
      assert.match(text, new RegExp(name));
    }
    assert.doesNotMatch(text, /not a url|99999/);
  });

  it('requires JWT keys of at least 256 bits, valid base64, unique kids', () => {
    assert.match(problemsOf({ ...valid(), JWT_KEYS: `k1:${key(31)}` }).join(), /at least 256 bits/);
    assert.match(problemsOf({ ...valid(), JWT_KEYS: 'k1:***' }).join(), /not valid base64/);
    assert.match(problemsOf({ ...valid(), JWT_KEYS: `k1:${key()},k1:${key()}` }).join(), /repeated/);
    assert.match(problemsOf({ ...valid(), JWT_KEYS: 'k1:CHANGE_ME' }).join(), /JWT_KEYS/);
    const c = loadConfig({ ...valid(), JWT_KEYS: `k1:${key()},k0:${key(64)}` });
    assert.deepEqual(
      c.jwtKeys.map((k) => k.kid),
      ['k1', 'k0'],
    );
  });

  it('checks ranges', () => {
    assert.match(problemsOf({ ...valid(), PORT: '0' }).join(), /PORT/);
    assert.match(problemsOf({ ...valid(), BCRYPT_COST: '3' }).join(), /BCRYPT_COST/);
    assert.match(problemsOf({ ...valid(), JWT_ACCESS_TTL_SECONDS: '30' }).join(), /JWT_ACCESS_TTL_SECONDS/);
    assert.match(problemsOf({ ...valid(), RATE_LIMIT_SESSION_MAX: 'many' }).join(), /RATE_LIMIT_SESSION_MAX/);
    assert.match(problemsOf({ ...valid(), LOG_LEVEL: 'loud' }).join(), /LOG_LEVEL/);
  });

  it('accepts only an exact origin, https in production', () => {
    assert.match(problemsOf({ ...valid(), FRONTEND_ORIGIN: 'http://localhost:5173/' }).join(), /FRONTEND_ORIGIN/);
    assert.match(problemsOf({ ...valid(), FRONTEND_ORIGIN: 'localhost:5173' }).join(), /FRONTEND_ORIGIN/);
    assert.match(problemsOf({ ...valid(), NODE_ENV: 'production' }).join(), /https in production/);
    assert.equal(
      loadConfig({ ...valid(), NODE_ENV: 'production', FRONTEND_ORIGIN: 'https://docs.example.com' }).frontendOrigin,
      'https://docs.example.com',
    );
  });

  it('requires a valid integration e-mail', () => {
    const rest = valid();
    delete rest.INTEGRATION_USER_EMAIL;
    assert.match(problemsOf(rest).join(), /INTEGRATION_USER_EMAIL: is required/);
    assert.match(problemsOf({ ...valid(), INTEGRATION_USER_EMAIL: 'nope' }).join(), /e-mail/);
  });

  it('parses TRUST_PROXY', () => {
    assert.equal(loadConfig({ ...valid(), TRUST_PROXY: 'true' }).trustProxy, true);
    assert.equal(loadConfig({ ...valid(), TRUST_PROXY: '1' }).trustProxy, 1);
    assert.equal(loadConfig({ ...valid(), TRUST_PROXY: 'loopback' }).trustProxy, 'loopback');
  });

  it('treats the Jira placeholders of .env.example as not configured, and validates real values', () => {
    const placeholders = {
      JIRA_BASE_URL: 'https://<site>.atlassian.net',
      JIRA_EMAIL: '<technical account email>',
      JIRA_API_TOKEN: 'CHANGE_ME',
      JIRA_PROJECT_KEY: 'TECHEA',
      JIRA_ISSUETYPE_EPIC_ID: '',
      JIRA_WEBHOOK_SECRET: 'CHANGE_ME',
    };
    assert.deepEqual(loadConfig({ ...valid(), ...placeholders }).jira, { projectKey: 'TECHEA' });
    assert.match(problemsOf({ ...valid(), JIRA_BASE_URL: 'http://x.atlassian.net' }).join(), /JIRA_BASE_URL/);
    assert.match(problemsOf({ ...valid(), JIRA_ISSUETYPE_STORY_ID: 'abc' }).join(), /JIRA_ISSUETYPE_STORY_ID/);
    assert.match(problemsOf({ ...valid(), JIRA_PROJECT_KEY: 'lower' }).join(), /JIRA_PROJECT_KEY/);
  });
});
