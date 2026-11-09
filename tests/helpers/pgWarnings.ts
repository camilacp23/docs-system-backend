/**
 * Detects the deprecation notice of the `pg` driver "Calling client.query() when the client is already executing a
 * query": it means two statements were sent on the same connection at once (for example `Promise.all` over the client
 * of a transaction). It is removed in pg 9, where it becomes a failure, so tests of code that must not do that watch it.
 */

/** The start of the notice, as `pg` words it. */
export const PG_OVERLAP_NOTICE = 'Calling client.query() when the client is already executing a query';

/**
 * Starts listening for the notice.
 *
 * @returns `stop()` ends the listening (more than once is fine) and returns the notices seen since the start.
 */
export function watchPgOverlap(): { stop: () => string[] } {
  const seen: string[] = [];
  const listener = (warning: Error): void => {
    if (warning.name === 'DeprecationWarning' && warning.message.includes(PG_OVERLAP_NOTICE)) {
      seen.push(warning.message);
    }
  };
  process.on('warning', listener);
  return {
    stop: () => {
      process.off('warning', listener);
      return seen;
    },
  };
}
