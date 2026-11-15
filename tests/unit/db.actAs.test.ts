/**
 * `actAs` (src/db/prisma.ts): the acting user of the audit trigger is validated before anything is sent to the
 * database, and it is set with the same transaction-local `set_config` that `auditedTransaction` has always used.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { actAs } from '../../src/db/prisma.js';

/** A transaction client that only records the parameters of the tagged template it receives. */
function fakeTx() {
  const calls: { sql: string; values: unknown[] }[] = [];
  const tx = {
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: strings.join('?'), values });
      return Promise.resolve(1);
    },
  };
  return { tx: tx as unknown as Parameters<typeof actAs>[0], calls };
}

describe('actAs', () => {
  it('sets app.user_id for the transaction with the id as a bound text parameter', async () => {
    const { tx, calls } = fakeTx();
    await actAs(tx, 42);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.sql, /set_config\('app\.user_id', \?, true\)/);
    assert.deepEqual(calls[0]!.values, ['42']);
  });

  it('rejects an id that is not a positive integer, without touching the database', async () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '7' as unknown as number]) {
      const { tx, calls } = fakeTx();
      await assert.rejects(actAs(tx, bad), TypeError, String(bad));
      assert.equal(calls.length, 0, String(bad));
    }
  });
});
