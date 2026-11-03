/**
 * Mutual exclusion by key (D-93): one at a time per key, in arrival order, other keys do not wait, a failure releases
 * the key, and nothing is left behind. No timers: the order is driven with promises.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createKeyedMutex } from '../../src/modules/screens/keyedMutex.js';

/** A promise that the test resolves by hand. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('createKeyedMutex', () => {
  it('runs calls with the same key one at a time and in arrival order', async () => {
    const mutex = createKeyedMutex<number>();
    const events: string[] = [];
    const first = gate();
    const a = mutex.run(1, async () => {
      events.push('a start');
      await first.promise;
      events.push('a end');
    });
    const b = mutex.run(1, () => {
      events.push('b');
      return Promise.resolve();
    });
    const c = mutex.run(1, () => {
      events.push('c');
      return Promise.resolve();
    });
    await turn();
    assert.deepEqual(events, ['a start'], 'b and c wait for a');
    first.open();
    await Promise.all([a, b, c]);
    assert.deepEqual(events, ['a start', 'a end', 'b', 'c']);
  });

  it('does not make a key wait for another key', async () => {
    const mutex = createKeyedMutex<number>();
    const held = gate();
    const slow = mutex.run(1, () => held.promise);
    const other = await mutex.run(2, () => Promise.resolve('done'));
    assert.equal(other, 'done');
    held.open();
    await slow;
  });

  it('passes the result through and releases the key when the function fails', async () => {
    const mutex = createKeyedMutex<string>();
    assert.equal(await mutex.run('k', () => Promise.resolve(42)), 42);
    await assert.rejects(
      mutex.run('k', () => Promise.reject(new Error('boom'))),
      /boom/,
    );
    assert.equal(
      await mutex.run('k', () => Promise.resolve('after')),
      'after',
      'a failure does not block the next call',
    );
  });

  it('leaves nothing behind when idle', async () => {
    const mutex = createKeyedMutex<number>();
    const held = gate();
    const running = [
      mutex.run(1, () => held.promise),
      mutex.run(1, () => Promise.resolve()),
      mutex.run(2, () => Promise.resolve()),
    ];
    await turn();
    assert.ok(mutex.pending() >= 1);
    held.open();
    await Promise.all(running);
    assert.equal(mutex.pending(), 0);
  });

  it('keeps the audit context of each caller (AsyncLocalStorage survives the wait)', async () => {
    const { AsyncLocalStorage } = await import('node:async_hooks');
    const store = new AsyncLocalStorage<{ user: number }>();
    const mutex = createKeyedMutex<number>();
    const held = gate();
    const seen: number[] = [];
    const call = (user: number, wait?: Promise<void>) =>
      store.run({ user }, () =>
        mutex.run(1, async () => {
          if (wait) await wait;
          seen.push(store.getStore()!.user);
        }),
      );
    const all = [call(1, held.promise), call(2), call(3)];
    await turn();
    held.open();
    await Promise.all(all);
    assert.deepEqual(seen, [1, 2, 3]);
    // After the wait, the continuation of each caller is still inside its own context.
    const after = await store.run({ user: 9 }, async () => {
      await mutex.run(1, () => Promise.resolve());
      return store.getStore()!.user;
    });
    assert.equal(after, 9);
  });
});
