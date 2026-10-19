/**
 * Express 4 does not catch rejected promises: an `async` handler that throws would hang the request.
 * `asyncHandler` forwards the rejection to `next`, so the errorHandler answers it.
 *
 * @module http/asyncHandler
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** A handler that may be `async`. */
export type AsyncRequestHandler = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

/**
 * Wraps a handler so a rejected promise reaches `next(err)`.
 *
 * @param fn - Sync or async Express handler.
 * @returns A plain Express handler.
 */
export function asyncHandler(fn: AsyncRequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
