/**
 * Preloaded in every process of `npm test` (`--import`): a test that sends a statement on a connection while another
 * one is running on it fails, with the text of the statements. It is the pg 9 behaviour, today, in every test.
 *
 * The only declared exception is `tests/integration/pgOverlap.watcher.test.ts`, which provokes it on purpose through
 * `allowPgOverlap`.
 *
 * @module tests/setup/failOnPgOverlap
 */
import { afterEach, after } from 'node:test';
import {
  installPgOverlapCounter,
  pgOverlapAllowedBecause,
  pgOverlapCount,
  pgOverlapsSince,
} from '../helpers/pgOverlap.js';

installPgOverlapCounter();

let checked = 0;

/** Throws when statements overlapped since the last check, unless this process declared it provokes them. */
function check(where: string): void {
  const seen = pgOverlapsSince(checked);
  checked = pgOverlapCount();
  if (seen.length === 0 || pgOverlapAllowedBecause() !== undefined) return;
  const sample = seen
    .slice(0, 5)
    .map((o) => `  - ${o.sql}`)
    .join('\n');
  throw new Error(
    `${seen.length} statement(s) were sent on a connection that was still running another one (${where}); pg 9 fails on this:\n${sample}`,
  );
}

afterEach((t) => {
  check(`test "${t.name}"`);
});
after(() => {
  check('after the last test');
});
