/** The sandbox fixtures refuse any database other than the exact name `docs_sandbox` (no database needed). */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertSandboxUrl, insertSandboxFixtures } from '../../scripts/lib/sandboxFixtures.js';

const urlOf = (database: string): string => `postgres://docs_owner:placeholder@localhost:5432/${database}`;

describe('sandbox fixtures guard', () => {
  it('accepts docs_sandbox', () => {
    assert.doesNotThrow(() => assertSandboxUrl(urlOf('docs_sandbox')));
  });

  for (const database of [
    'docs_system',
    'docs_shadow',
    'docs_test_template',
    'docs_test_ab12',
    'docs_sandbox_2',
    'postgres',
    '',
  ]) {
    it(`rejects "${database}"`, () => {
      assert.throws(() => assertSandboxUrl(urlOf(database)), /Refusing to insert fixtures/);
    });
  }

  it('rejects a URL that cannot be parsed', () => {
    assert.throws(() => assertSandboxUrl('not a url'), /Refusing to insert fixtures/);
  });

  it('rejects before connecting: no connection is attempted for docs_system', async () => {
    // Port 1 would fail with ECONNREFUSED if the guard let the call reach the driver.
    await assert.rejects(
      insertSandboxFixtures('postgres://docs_owner:placeholder@localhost:1/docs_system', 'admin@sandbox.local'),
      /Refusing to insert fixtures into database "docs_system"/,
    );
  });
});
