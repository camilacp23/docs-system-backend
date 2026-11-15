/**
 * ETag and If-Match (SDD Table 44 "Concurrency", D-24, D-62).
 *
 * The contract defines the ETag as a weak validator derived from `updatedAt`: `W/"<epoch ms>"`
 * (`components.headers.ETag`). `If-Match` is optional; when present it is compared EXACTLY with the current ETag,
 * inside the same transaction that reads the resource, and a mismatch is 412 PRECONDITION_FAILED with
 * `details.currentETag`.
 *
 * IMPORTANT for the modules: the ETag of a resource is derived from its own `updated_at`. Any write to its nested
 * arrays (components, variable and collection links, fields, assignments, environments...) MUST also touch
 * `updated_at` of the parent resource, or two editors would see the same ETag for different documents.
 *
 * @module http/etag
 */
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { E } from '../security/errors.js';

/**
 * ETag of a resource that has `updatedAt`.
 *
 * @param resource - Anything with an `updatedAt` Date (or ISO string).
 * @returns `W/"<epoch ms>"`.
 */
export function etagOf(resource: { updatedAt: Date | string }): string {
  return `W/"${new Date(resource.updatedAt).getTime()}"`;
}

/**
 * ETag for a representation without `updatedAt` (use only when a resource has none): a weak hash of its JSON.
 *
 * @param representation - JSON-serializable value.
 * @returns `W/"<16 hex>"`.
 */
export function etagOfJson(representation: unknown): string {
  return `W/"${createHash('sha256').update(JSON.stringify(representation)).digest('hex').slice(0, 16)}"`;
}

/**
 * ETag of a comment (D-123): `W/"<epoch ms of updatedAt, or of createdAt when updatedAt is null>"`. It is the same in
 * the 201, the 200 of the edit and what a client builds from an item of the list (the list keeps its own hash, D-72).
 *
 * @param comment - The comment as the API returns it.
 * @returns The weak ETag.
 */
export function commentEtagOf(comment: { createdAt: Date | string; updatedAt: Date | string | null }): string {
  return etagOf({ updatedAt: comment.updatedAt ?? comment.createdAt });
}

/** Counters that are part of the ETag of a screen (they change without touching `updated_at`). */
export type ScreenEtagSource = { updatedAt: Date | string; pendingSubtasks: number; commentCount: number };

/** `W/"<updatedAt ms>"`, optionally followed by `-<pendingSubtasks>-<commentCount>`; captures the milliseconds. */
const SCREEN_ETAG = /^W\/"(\d+)(?:-\d+-\d+)?"$/;

/**
 * ETag of a screen (D-101): `W/"<updatedAt ms>-<pendingSubtasks>-<commentCount>"`. The counters change without
 * touching `updated_at` (Jira tickets, comments), so they are part of the validator used by `If-None-Match`.
 *
 * @param screen - The screen as the API returns it.
 * @returns The weak ETag.
 */
export function screenEtagOf(screen: ScreenEtagSource): string {
  return `W/"${new Date(screen.updatedAt).getTime()}-${screen.pendingSubtasks}-${screen.commentCount}"`;
}

/**
 * Verifies `If-Match` of a screen (D-101): only the `updatedAt` part is compared, so a change of the counters between
 * the read and the save is not a 412. The former format `W/"<ms>"` is accepted; any other format is a mismatch.
 *
 * @param req - Request.
 * @param element - Noun of the resource for the message ("screen").
 * @param currentETag - Full ETag (`screenEtagOf`) of the row as read INSIDE the transaction that will write.
 * @throws {ApiError} 412 PRECONDITION_FAILED with the full `details.currentETag`.
 */
export function assertScreenIfMatch(req: Request, element: string, currentETag: string): void {
  const supplied = req.get('if-match');
  if (supplied === undefined) return;
  const suppliedMs = SCREEN_ETAG.exec(supplied)?.[1];
  const currentMs = SCREEN_ETAG.exec(currentETag)?.[1];
  if (suppliedMs === undefined || suppliedMs !== currentMs) throw E.preconditionFailed(element, currentETag);
}

/**
 * Sets the ETag header of a response.
 *
 * @param res - Response.
 * @param etag - Value from `etagOf` / `etagOfJson`.
 */
export function setEtag(res: Response, etag: string): void {
  res.setHeader('ETag', etag);
}

/**
 * Verifies `If-Match` against the current ETag. Without the header there is nothing to check.
 *
 * @param req - Request.
 * @param element - Noun of the resource for the message ("screen").
 * @param currentETag - ETag of the row as read INSIDE the transaction that will write.
 * @throws {ApiError} 412 PRECONDITION_FAILED with `details.currentETag`.
 */
export function assertIfMatch(req: Request, element: string, currentETag: string): void {
  const supplied = req.get('if-match');
  if (supplied !== undefined && supplied !== currentETag) throw E.preconditionFailed(element, currentETag);
}

/**
 * Sets `Location` for a 201 response.
 *
 * @param res - Response.
 * @param collectionPath - Contract path of the collection (for example `/variables`).
 * @param id - Id of the created resource.
 */
export function setLocation(res: Response, collectionPath: string, id: number | string): void {
  res.setHeader('Location', `/api/v1${collectionPath}/${id}`);
}
