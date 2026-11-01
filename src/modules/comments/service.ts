/**
 * Comment rules (FR-23, FR-24; CP-11, D-56, D-88). For now the service only writes the comment that records a review
 * decision, on behalf of the screens module, which orchestrates `POST /screens/{id}/review` and owns its transaction.
 * It never sees req/res and it opens no transaction of its own: it writes in the caller's `auditedTransaction`, so the
 * comment, the new status and the business event commit or roll back together.
 *
 * @module modules/comments/service
 */
import type { ReviewDecision } from '../../generated/prisma/client.js';
import * as repo from './repository.js';

/** What the screens module hands over to record a review decision. */
export type ReviewCommentInput = {
  screenId: number;
  /** The caller of the review: the author of the comment. */
  authorId: number;
  /** The text as the client sent it (the `trim` only decides whether there is content, D-88). */
  text: string;
  decision: ReviewDecision;
};

/** The comments service. */
export type CommentService = {
  /**
   * Writes the review comment of a decision inside the caller's transaction. Only the review writes
   * `reviewDecision` (CP-11).
   *
   * @param tx - Transaction client of `auditedTransaction`.
   * @param input - The decision and its comment.
   * @returns The id of the new comment.
   */
  recordReviewComment(tx: repo.CommentsClient, input: ReviewCommentInput): Promise<number>;
};

/** Creates the comments service. */
export function createCommentService(): CommentService {
  return {
    recordReviewComment: (tx, input) =>
      repo.createReviewComment(tx, {
        screenId: input.screenId,
        userId: input.authorId,
        text: input.text,
        reviewDecision: input.decision,
      }),
  };
}
