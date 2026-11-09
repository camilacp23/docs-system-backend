/**
 * Checks that a real response matches what `api/openapi.yaml` declares for it (status, headers aside, and body).
 *
 * The API does not validate its responses at run time (`validateResponses` is off in `src/http/chain.ts`), so a
 * response schema that does not describe what the API sends goes unnoticed. This helper closes that gap in tests
 * without a new dependency: it replays the captured status and body through a throwaway Express app that mounts the
 * same `express-openapi-validator` the API already uses, with response validation on and request validation off. The
 * validator picks the operation from the method and path of the original request, so it also reports a status code
 * the contract does not declare.
 *
 * @module tests/helpers/contractResponse
 */
import assert from 'node:assert/strict';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import supertest from 'supertest';
import { DEFAULT_OPENAPI_PATH } from '../../src/app.js';

/** The parts of a supertest response the check needs. */
export type CapturedResponse = {
  status: number;
  body: unknown;
  request: { method: string; url: string };
};

/** Replays one captured response through the contract's response validator; returns the problems found. */
async function validateAgainstContract(res: CapturedResponse, openapiPath: string): Promise<string[]> {
  const problems: string[] = [];
  const app = express();
  app.use(
    OpenApiValidator.middleware({
      apiSpec: openapiPath,
      validateRequests: false,
      validateSecurity: false,
      validateResponses: {
        onError: (err) => {
          problems.push(err.message);
        },
      },
      ignoreUndocumented: false,
    }),
  );
  app.all('*', (_req, out) => {
    out.status(res.status).json(res.body);
  });
  // A path or method the contract does not know is rejected by the validator before the replay handler.
  app.use((err: Error, _req: express.Request, out: express.Response, _next: express.NextFunction) => {
    problems.push(err.message);
    out.status(500).end();
  });
  const { pathname, search } = new URL(res.request.url);
  await supertest(app)[res.request.method.toLowerCase() as 'get' | 'post' | 'put' | 'delete'](pathname + search);
  return problems;
}

/**
 * Asserts that a response conforms to the contract.
 *
 * @param res - A supertest response (its `request` gives the method and URL of the call).
 * @param openapiPath - The contract to check against; the API's own by default.
 * @throws AssertionError listing every difference the validator reports.
 */
export async function assertConformsToContract(
  res: CapturedResponse,
  openapiPath: string = DEFAULT_OPENAPI_PATH,
): Promise<void> {
  const problems = await validateAgainstContract(res, openapiPath);
  assert.deepEqual(
    problems,
    [],
    `${res.request.method} ${res.request.url} answered ${res.status} and the response does not match the contract`,
  );
}
