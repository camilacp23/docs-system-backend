/**
 * Comment rules (FR-23, FR-24; CP-11, D-56, D-88, D-122, D-123, D-132). The service never sees req/res.
 *
 * - `list`: the screen must exist (404); oldest first.
 * - `create`: 404 -> APPLICATION_ARCHIVED, in the caller's audited transaction; any screen status is allowed.
 * - `update`: locks the comment FOR UPDATE, then 404 -> 403 AUTHOR_ONLY -> 422 APPLICATION_ARCHIVED -> 412 -> 422
 *   REVIEW_COMMENT_LOCKED; the same text writes nothing. Lock order: comment, then application (FOR SHARE).
 * - `recordReviewComment`: writes the comment of a review decision in the transaction of the screens module, which
 *   orchestrates `POST /screens/{id}/review` (D-88). It is the same insert as an ordinary comment.
 *
 * The screen and its application are found through the screens service (D-80), never through its repository.
 *
 * @module modules/comments/service
 */
import type { Database } from '../../db/prisma.js';
import type { ReviewDecision } from '../../generated/prisma/client.js';
import { commentEtagOf } from '../../http/etag.js';
import { E } from '../../security/errors.js';
import type { ApplicationService } from '../applications/service.js';
import type { ScreenLookup } from '../screens/service.js';
import * as repo from './repository.js';

const SCREEN = 'screen';
const COMMENT = 'comment';

/** What the screens module hands over to record a review decision. */
export type ReviewCommentInput = {
  screenId: number;
  /** The caller of the review: the author of the comment. */
  authorId: number;
  /** The text as the client sent it (the `trim` only decides whether there is content, D-88). */
  text: string;
  decision: ReviewDecision;
};

/** Checks `If-Match` against the current ETag of the locked comment; throws 412 when it does not match. */
export type PreconditionCheck = (currentETag: string) => void;

/** The comments service. */
export type CommentService = {
  /** Page of the comments of a screen, oldest first (404 when the screen does not exist). */
  list(screenId: number, page: { skip: number; take: number }): Promise<{ data: repo.CommentView[]; total: number }>;
  /** `POST /screens/{id}/comments`: the author is the caller; the text is stored as it arrives. */
  create(actorId: number, screenId: number, text: string): Promise<repo.CommentView>;
  /** `PUT /comments/{id}`: author only; see the module description for the order of the errors. */
  update(actorId: number, id: number, text: string, assertCurrent: PreconditionCheck): Promise<repo.CommentView>;
  /**
   * Writes the review comment of a decision inside the caller's transaction. Only the review writes
   * `reviewDecision` (CP-11).
   *
   * @param tx - Transaction client of `auditedTransaction`.
   * @param input - The decision and its comment.
   * @returns The id of the new comment.
   */
  recordReviewComment(tx: Pick<repo.CommentsClient, 'comment'>, input: ReviewCommentInput): Promise<number>;
};

/**
 * Creates the comments service.
 *
 * @param db - Database connected as docs_app.
 * @param applications - Applications service (the guard of the archived application, D-47).
 * @param screens - Read-only screen lookup (D-80).
 */
export function createCommentService(
  db: Pick<Database, 'base' | 'auditedTransaction'>,
  applications: Pick<ApplicationService, 'assertApplicationActive'>,
  screens: ScreenLookup,
): CommentService {
  return {
    async list(screenId, page) {
      const screen = await screens.findRef(db.base, screenId);
      if (!screen) throw E.notFound(SCREEN, screenId);
      return repo.listCommentsOfScreen(db.base, screenId, page);
    },

    create(actorId, screenId, text) {
      return db.auditedTransaction(async (tx) => {
        const screen = await screens.findRef(tx, screenId);
        if (!screen) throw E.notFound(SCREEN, screenId);
        await applications.assertApplicationActive(tx, screen.applicationId);
        const id = await repo.insertComment(tx, { screenId, userId: actorId, text, reviewDecision: null });
        const created = await repo.findCommentById(tx, id);
        return created!;
      });
    },

    update(actorId, id, text, assertCurrent) {
      return db.auditedTransaction(async (tx) => {
        if (!(await repo.lockCommentForUpdate(tx, id))) throw E.notFound(COMMENT, id);
        const current = await repo.findCommentById(tx, id);
        if (!current) throw E.notFound(COMMENT, id);
        if (current.author.id !== actorId) throw E.forbiddenAuthorOnly();
        const screen = await screens.findRef(tx, current.screenId);
        if (!screen) throw E.notFound(SCREEN, current.screenId);
        await applications.assertApplicationActive(tx, screen.applicationId);
        assertCurrent(commentEtagOf(current));
        if (current.reviewDecision !== null) throw E.reviewCommentLocked();
        // The same text, compared exactly (spaces included), writes nothing: same ETag, same updatedAt (D-71, D-123).
        if (text === current.text) return current;
        await repo.updateCommentText(tx, id, text);
        const updated = await repo.findCommentById(tx, id);
        return updated!;
      });
    },

    recordReviewComment: (tx, input) =>
      repo.createReviewComment(tx, {
        screenId: input.screenId,
        userId: input.authorId,
        text: input.text,
        reviewDecision: input.decision,
      }),
  };
}
