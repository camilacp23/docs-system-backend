/**
 * Mutual exclusion by key inside one process (D-93). It holds no database connection and no transaction: a caller
 * that waits is just a pending promise. It is NOT a shared lock: with several API instances each one has its own.
 *
 * @module modules/screens/keyedMutex
 */

/** Runs functions one at a time per key, in the order they arrive. */
export type KeyedMutex<K> = {
  /**
   * Runs `fn` when every earlier call with the same key has finished. Calls with other keys do not wait.
   *
   * @param key - What is being protected (for example a screen id).
   * @param fn - The critical section; its result or error is passed through, and the key is released either way.
   */
  run<T>(key: K, fn: () => Promise<T>): Promise<T>;
  /** Keys with a running or waiting call (0 when idle: the map never grows without bound). */
  pending(): number;
};

/** Creates a mutex. */
export function createKeyedMutex<K>(): KeyedMutex<K> {
  // The tail of each key's queue. It only ever resolves (never rejects), so a failure of one caller cannot poison the next.
  const tails = new Map<K, Promise<void>>();
  return {
    async run<T>(key: K, fn: () => Promise<T>): Promise<T> {
      const previous = tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => mine);
      tails.set(key, tail);
      await previous;
      try {
        return await fn();
      } finally {
        release();
        if (tails.get(key) === tail) tails.delete(key);
      }
    },
    pending: () => tails.size,
  };
}
