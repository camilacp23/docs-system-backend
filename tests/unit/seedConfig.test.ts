/** loadSeedConfig: required variables, password policy from the contract, distinct e-mails (NFR-02). */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError } from '../../src/config/index.js';
import { loadPasswordPattern, loadSeedConfig } from '../../src/config/seed.js';

const valid = (): NodeJS.ProcessEnv => ({
  APP_DATABASE_URL: 'postgresql://docs_app:secret@localhost:5432/docs_system',
  SEED_ADMIN_NAME: 'Ada Admin',
  SEED_ADMIN_EMAIL: 'Ada.Admin@Example.com',
  SEED_ADMIN_PASSWORD: 'correct-horse-9',
  INTEGRATION_USER_EMAIL: 'integracion.jira@system.local',
});

const problemsOf = (env: NodeJS.ProcessEnv): string[] => {
  try {
    loadSeedConfig(env);
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    return e.problems;
  }
  return assert.fail('loadSeedConfig should have thrown');
};

describe('loadSeedConfig', () => {
  it('lowercases the e-mails and defaults the bcrypt cost', () => {
    const c = loadSeedConfig(valid());
    assert.equal(c.adminEmail, 'ada.admin@example.com');
    assert.equal(c.bcryptCost, 12);
  });

  it('reads the password policy from the contract', () => {
    const pattern = loadPasswordPattern();
    assert.ok(pattern.test('abcdefghij12'));
    assert.ok(!pattern.test('short1'));
    assert.ok(!pattern.test('onlyletterslong'));
    assert.ok(!pattern.test('1234567890123'));
  });

  it('rejects a password outside the policy without printing it', () => {
    const problems = problemsOf({ ...valid(), SEED_ADMIN_PASSWORD: 'onlyletterslong' });
    assert.deepEqual(problems, [
      'SEED_ADMIN_PASSWORD: does not meet the password policy (12-128 characters with letters and digits)',
    ]);
  });

  it('rejects equal administrator and integration e-mails (case-insensitive)', () => {
    const problems = problemsOf({ ...valid(), SEED_ADMIN_EMAIL: 'Integracion.Jira@system.local' });
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /^SEED_ADMIN_EMAIL: must differ from INTEGRATION_USER_EMAIL/);
  });

  it('reports every missing variable, including the CHANGE_ME placeholder', () => {
    const problems = problemsOf({ SEED_ADMIN_PASSWORD: 'CHANGE_ME' });
    assert.deepEqual(problems.map((p) => p.split(':')[0]).sort(), [
      'APP_DATABASE_URL',
      'INTEGRATION_USER_EMAIL',
      'SEED_ADMIN_EMAIL',
      'SEED_ADMIN_NAME',
      'SEED_ADMIN_PASSWORD',
    ]);
  });
});
