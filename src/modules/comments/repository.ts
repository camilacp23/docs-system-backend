/**
 * Prisma queries of the comments module. No rules live here (SDD Table 6, D-42). Only the review comment is written so
 * far; the endpoints of Module 10 do not exist yet.
 *
 * @module modules/comments/repository
 */
import type { PrismaClient, ReviewDecision } from '../../generated/prisma/client.js';

/** Clients accepted by the queries: the transaction client of `auditedTransaction`. */
export type CommentsClient = Pick<PrismaClient, 'comment'>;

/** The columns of a review comment. */
export type ReviewCommentData = { screenId: number; userId: number; text: string; reviewDecision: ReviewDecision };

/** Inserts a comment that records a review decision (CP-11) and returns its id. */
export async function createReviewComment(client: CommentsClient, data: ReviewCommentData): Promise<number> {
  const row = await client.comment.create({ data, select: { id: true } });
  return row.id;
}
