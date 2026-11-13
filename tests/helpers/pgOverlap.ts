/**
 * Exact count of the statements sent on a connection while another one was still running on it (what `pg` 8 answers
 * with the deprecation notice "Calling client.query() when the client is already executing a query", and pg 9 with a
 * failure). Unlike the notice, which `pg` words once per process, this counts every statement and keeps its text, so a
 * test can say "this operation caused none" and a failure shows which statements overlapped.
 *
 * `pg.Client.prototype.query` is wrapped once per process, on first use. Nothing here is loaded by the API.
 *
 * @module tests/helpers/pgOverlap
 */
import pg from 'pg';

/** One statement that was sent while another was running on the same connection. */
export type PgOverlap = { sql: string };

const state: { installed: boolean; overlaps: PgOverlap[]; allowed: string | undefined } = {
  installed: false,
  overlaps: [],
  allowed: undefined,
};

type Patched = pg.Client & { __pending?: number };

/** Wraps `pg.Client.prototype.query` (idempotent). */
export function installPgOverlapCounter(): void {
  if (state.installed) return;
  state.installed = true;
  const original = Reflect.get(pg.Client.prototype, 'query') as (this: pg.Client, ...args: unknown[]) => unknown;
  (pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown }).query = function patched(
    this: Patched,
    ...args: unknown[]
  ): unknown {
    const result = original.apply(this, args);
    const first = args[0];
    if (typeof first === 'function' || !(result instanceof Promise)) return result;
    const pending = this.__pending ?? 0;
    if (pending > 0) {
      const text = typeof first === 'string' ? first : ((first as { text?: string } | undefined)?.text ?? '');
      state.overlaps.push({ sql: text.replace(/\s+/g, ' ').slice(0, 160) });
    }
    this.__pending = pending + 1;
    const done = (): void => {
      this.__pending = (this.__pending ?? 1) - 1;
    };
    result.then(done, done);
    return result;
  };
}

/** How many overlapping statements were counted so far in this process. */
export const pgOverlapCount = (): number => state.overlaps.length;

/**
 * Starts counting.
 *
 * @returns `stop()` returns the overlapping statements sent since the start (the counter keeps running).
 */
export function trackPgOverlap(): { stop: () => PgOverlap[] } {
  installPgOverlapCounter();
  const from = state.overlaps.length;
  return { stop: () => state.overlaps.slice(from) };
}

/** The overlapping statements counted since the `from`-th one. */
export const pgOverlapsSince = (from: number): PgOverlap[] => state.overlaps.slice(from);

/**
 * Declares that the tests of this process overlap statements ON PURPOSE (the detector's own test), so the global check of
 * `tests/setup/failOnPgOverlap.ts` does not fail them. Every other test file must not call it.
 *
 * @param reason - Why, for the record.
 */
export function allowPgOverlap(reason: string): void {
  state.allowed = reason;
}

/** The reason given to `allowPgOverlap`, or `undefined` when the process did not declare one. */
export const pgOverlapAllowedBecause = (): string | undefined => state.allowed;
