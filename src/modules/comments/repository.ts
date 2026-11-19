/**
 * Prisma queries of the comments module. No rules live here (SDD Table 6, D-42).
 *
 * @module modules/comments/repository
 */
import type { PrismaClient, ReviewDecision } from '../../generated/prisma/client.js';

/** Clients accepted by the queries: the transaction client of `auditedTransaction`, or the plain client for reads. */
export type CommentsClient = Pick<PrismaClient, 'comment' | '$queryRaw'>;

/** The columns of a new comment. `reviewDecision` is only set by the review (CP-11). */
export type CommentData = { screenId: number; userId: number; text: string; reviewDecision: ReviewDecision | null };

/** A comment as the API returns it (contract `Comment`). The author is shown even when the user is inactive. */
export type CommentView = {
  id: number;
  screenId: number;
  author: { id: number; name: string };
  text: string;
  reviewDecision: ReviewDecision | null;
  createdAt: Date;
  updatedAt: Date | null;
};

const VIEW_SELECT = {
  id: true,
  screenId: true,
  text: true,
  reviewDecision: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { id: true, name: true } },
} as const;

type ViewRow = {
  id: number;
  screenId: number;
  text: string;
  reviewDecision: ReviewDecision | null;
  createdAt: Date;
  updatedAt: Date | null;
  user: { id: number; name: string };
};

const toView = ({ user, ...row }: ViewRow): CommentView => ({ ...row, author: user });

/** The only insert of a comment: the ordinary one (`reviewDecision` null) and the review's (CP-11) share it. */
export async function insertComment(client: Pick<PrismaClient, 'comment'>, data: CommentData): Promise<number> {
  const row = await client.comment.create({ data, select: { id: true } });
  return row.id;
}

/** Inserts a comment that records a review decision (CP-11) and returns its id. */
export function createReviewComment(
  client: Pick<PrismaClient, 'comment'>,
  data: CommentData & { reviewDecision: ReviewDecision },
): Promise<number> {
  return insertComment(client, data);
}

/** One comment with its author, or `null`. */
export async function findCommentById(client: Pick<PrismaClient, 'comment'>, id: number): Promise<CommentView | null> {
  const row = await client.comment.findUnique({ where: { id }, select: VIEW_SELECT });
  return row === null ? null : toView(row);
}

/** Page of the comments of a screen, oldest first: `createdAt` and then `id` (stable). */
export async function listCommentsOfScreen(
  client: Pick<PrismaClient, 'comment'>,
  screenId: number,
  page: { skip: number; take: number },
): Promise<{ data: CommentView[]; total: number }> {
  const rows = await client.comment.findMany({
    where: { screenId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    skip: page.skip,
    take: page.take,
    select: VIEW_SELECT,
  });
  const total = await client.comment.count({ where: { screenId } });
  return { data: rows.map(toView), total };
}

/**
 * Locks the comment `FOR UPDATE` until the end of the transaction (D-123, D-71): two edits with the same `If-Match`
 * are serialized, and the second one reads what the first committed.
 *
 * @returns `true` when the comment exists.
 */
export async function lockCommentForUpdate(client: Pick<PrismaClient, '$queryRaw'>, id: number): Promise<boolean> {
  const rows = await client.$queryRaw<{ id: number }[]>`SELECT id FROM comment WHERE id = ${id} FOR UPDATE`;
  return rows.length > 0;
}

/**
 * Writes the new text and sets `updated_at` (D-132), in the same statement and after the lock:
 * `GREATEST(clock_timestamp(), COALESCE(updated_at, created_at) + 1 ms)` cut to milliseconds. `now()` is not used (it is
 * the start of the transaction, which may be older than the edit that was just committed) and neither is the clock of
 * Node. The value therefore never goes back and changes with every real edit, so the ETag (milliseconds) does too.
 */
export async function updateCommentText(
  client: Pick<PrismaClient, '$executeRaw'>,
  id: number,
  text: string,
): Promise<void> {
  await client.$executeRaw`
    UPDATE comment
       SET text = ${text},
           updated_at = date_trunc('milliseconds',
                          GREATEST(clock_timestamp(), COALESCE(updated_at, created_at) + interval '1 millisecond'))
     WHERE id = ${id}`;
}
