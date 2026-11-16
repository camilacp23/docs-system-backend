/**
 * Helpers of the comments tests (Module 10): the contract's response shape, typed readers, fixtures written as
 * docs_owner and the wait for requests that are blocked by a row lock. Everything runs on the disposable database of
 * `startTestApp`.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import type { TestApp } from './app.js';

/** A comment as the API returns it. */
export type CommentBody = {
  id: number;
  screenId: number;
  author: { id: number; name: string };
  text: string;
  reviewDecision: 'APPROVE' | 'RETURN' | null;
  createdAt: string;
  updatedAt: string | null;
};

/** Typed view of a single-comment response. */
export const commentOf = (res: { body: unknown }): CommentBody => (res.body as { data: CommentBody }).data;

/** Typed view of the comments page. */
export const commentsPageOf = (res: { body: unknown }) =>
  res.body as { data: CommentBody[]; page: number; pageSize: number; total: number };

/** The ETag a client builds from an item of the list (D-123): `W/"<ms of updatedAt, or of createdAt>"`. */
export const etagFromItem = (c: CommentBody): string => `W/"${new Date(c.updatedAt ?? c.createdAt).getTime()}"`;

/** Inserts a comment as docs_owner (any author, even an inactive one) and returns its id. */
export async function insertCommentRow(
  t: Pick<TestApp, 'owner'>,
  screenId: number,
  userId: number,
  text: string,
  over: { createdAt?: string; reviewDecision?: 'APPROVE' | 'RETURN' } = {},
): Promise<number> {
  const r = await t.owner.query<{ id: number }>(
    `INSERT INTO comment (screen_id, user_id, text, created_at, review_decision)
     VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()), $5::review_decision) RETURNING id`,
    [screenId, userId, text, over.createdAt ?? null, over.reviewDecision ?? null],
  );
  return r.rows[0]!.id;
}

/** The rows of `comment` of a screen as stored. */
export async function storedComments(t: Pick<TestApp, 'owner'>, screenId: number) {
  return (
    await t.owner.query<{ id: number; user_id: number; text: string; updated_at: Date | null; created_at: Date }>(
      `SELECT id, user_id, text, created_at, updated_at FROM comment WHERE screen_id = $1 ORDER BY id`,
      [screenId],
    )
  ).rows;
}

/**
 * Waits (polling, no fixed pause) until `count` backends are blocked, directly or behind another waiter (the second one waits for the tuple
 * lock of the first), by a lock that the owner connection of the test holds, so the test can release it only when the requests under test are really queued behind it. Gives up after
 * `timeoutMs` and returns `false`, so a broken lock shows as a failed assertion and not as a hang.
 */
export async function waitForLockWaiters(t: Pick<TestApp, 'owner'>, count: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await t.owner.query<{ n: number }>(
      `WITH RECURSIVE waiters(pid) AS (
         SELECT pid FROM pg_locks WHERE NOT granted AND pg_backend_pid() = ANY(pg_blocking_pids(pid))
         UNION
         SELECT l.pid FROM pg_locks l JOIN waiters w ON w.pid = ANY(pg_blocking_pids(l.pid)) WHERE NOT l.granted
       ) SELECT count(DISTINCT pid)::int AS n FROM waiters`,
    );
    if (r.rows[0]!.n >= count) return true;
    await sleep(20);
  }
  return false;
}
