/**
 * Modules 9 to 11 (FR-22 to FR-25): every JSON example of the responses of reports, comments and onboarding conforms
 * to the schema it is declared under, every request example is accepted by the request validator, and the schemas
 * reject what they must not accept. Unit test: no database and no server; it uses the validator the API uses.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import supertest from 'supertest';
import { parse } from 'yaml';
import { DEFAULT_OPENAPI_PATH } from '../../src/app.js';
import { assertConformsToContract } from '../helpers/contractResponse.js';

type Example = { value: unknown };
type MediaType = { example?: unknown; examples?: Record<string, Example> };
type Response = { $ref?: string; content?: Record<string, MediaType> };
type Operation = { responses: Record<string, Response>; requestBody?: { content: Record<string, MediaType> } };
type Contract = {
  paths: Record<string, Record<string, Operation>>;
  components: { responses: Record<string, Response> };
};

const contract = parse(readFileSync(DEFAULT_OPENAPI_PATH, 'utf8')) as Contract;

/** The operations of Modules 9 to 11 that this contract version describes, with a concrete URL for each. */
const OPERATIONS: { method: 'get' | 'post' | 'put' | 'delete'; path: string; url: string }[] = [
  { method: 'post', path: '/reports/pdf', url: '/reports/pdf' },
  { method: 'post', path: '/reports/excel', url: '/reports/excel' },
  { method: 'get', path: '/reports', url: '/reports?applicationId=1' },
  { method: 'get', path: '/reports/{id}', url: '/reports/12' },
  { method: 'get', path: '/reports/{id}/file', url: '/reports/12/file' },
  { method: 'put', path: '/reports/{id}/publication', url: '/reports/12/publication' },
  { method: 'get', path: '/screens/{id}/comments', url: '/screens/7/comments' },
  { method: 'post', path: '/screens/{id}/comments', url: '/screens/7/comments' },
  { method: 'put', path: '/comments/{id}', url: '/comments/31' },
  { method: 'get', path: '/onboarding/summary', url: '/onboarding/summary?applicationId=1' },
  { method: 'get', path: '/onboarding/progress', url: '/onboarding/progress?applicationId=1' },
  { method: 'put', path: '/onboarding/progress/steps/{step}', url: '/onboarding/progress/steps/3?applicationId=1' },
  { method: 'delete', path: '/onboarding/progress', url: '/onboarding/progress?applicationId=1' },
];

/** The JSON examples of a media type, by name (a single `example` is named `example`). */
const examplesOf = (media: MediaType | undefined): [string, unknown][] => {
  if (media === undefined) return [];
  if (media.example !== undefined) return [['example', media.example]];
  return Object.entries(media.examples ?? {}).map(([name, e]) => [name, e.value]);
};

/** A response as declared, following a reference to `components.responses`. */
const resolve = (response: Response): Response =>
  response.$ref === undefined ? response : contract.components.responses[response.$ref.split('/').pop()!]!;

const call = (method: string, url: string) => ({ method: method.toUpperCase(), url: `http://localhost/api/v1${url}` });

describe('contract: the response examples of Modules 9 to 11 conform to their schemas', () => {
  const sharedChecked = new Set<string>();
  for (const op of OPERATIONS) {
    const operation = contract.paths[op.path]![op.method]!;
    describe(`${op.method.toUpperCase()} ${op.path}`, () => {
      let withBody = 0;
      for (const [status, declared] of Object.entries(operation.responses)) {
        const media = resolve(declared).content?.['application/json'];
        if (media === undefined) continue;
        for (const [name, value] of examplesOf(media)) {
          withBody += 1;
          // A response shared through `$ref` is replayed once, on the first operation that uses it.
          if (declared.$ref !== undefined) {
            const key = `${declared.$ref}:${name}`;
            if (sharedChecked.has(key)) continue;
            sharedChecked.add(key);
          }
          it(`${status}: ${name}`, async () => {
            await assertConformsToContract({ status: Number(status), body: value, request: call(op.method, op.url) });
          });
        }
      }
      it('has examples', () => {
        assert.ok(withBody > 0);
      });
    });
  }

  it('every 2xx with a JSON body has an example', () => {
    for (const op of OPERATIONS) {
      for (const [status, declared] of Object.entries(contract.paths[op.path]![op.method]!.responses)) {
        if (!status.startsWith('2')) continue;
        const media = resolve(declared).content?.['application/json'];
        if (media !== undefined) assert.ok(examplesOf(media).length > 0, `${op.method} ${op.path} ${status}`);
      }
    }
  });
});

describe('contract: the request examples of Modules 9 to 11 are accepted by the request validator', () => {
  const app = express();
  app.use(express.json());
  app.use(
    OpenApiValidator.middleware({
      apiSpec: DEFAULT_OPENAPI_PATH,
      validateRequests: true,
      validateResponses: false,
      validateSecurity: false,
    }),
  );
  app.all('*', (_req, res) => {
    res.status(200).json({});
  });
  app.use(
    (
      err: { status?: number; message: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(err.status ?? 500).json({ message: err.message });
    },
  );

  const send = (method: 'post' | 'put', url: string, body: unknown) =>
    supertest(app)
      [method](`/api/v1${url}`)
      .send(body as object);

  for (const op of OPERATIONS.filter((o) => o.method !== 'get')) {
    const media = contract.paths[op.path]![op.method]!.requestBody?.content['application/json'];
    for (const [name, value] of examplesOf(media)) {
      it(`${op.method.toUpperCase()} ${op.path}: ${name}`, async () => {
        const res = await send(op.method as 'post' | 'put', op.url, value);
        assert.equal(res.status, 200, JSON.stringify(res.body));
      });
    }
  }

  const base = { applicationId: 1, title: 'Report', scope: { elementTypes: ['SCREEN'] }, publish: false };
  const withScope = (scope: unknown) => ({ ...base, scope });

  it('accepts what the service judges afterwards: an empty or a repeated elementTypes', async () => {
    assert.equal((await send('post', '/reports/pdf', withScope({ elementTypes: [] }))).status, 200);
    assert.equal((await send('post', '/reports/pdf', withScope({ elementTypes: ['SCREEN', 'SCREEN'] }))).status, 200);
  });

  const rejected: [string, unknown][] = [
    ['a title of only whitespace', { ...base, title: ' \t ' }],
    ['a title of 201 characters', { ...base, title: 'x'.repeat(201) }],
    ['a missing publish', { applicationId: 1, title: 'Report', scope: { elementTypes: ['SCREEN'] } }],
    ['a missing elementTypes', withScope({ includeStatusSummary: true })],
    ['five element types', withScope({ elementTypes: ['SCREEN', 'VARIABLE', 'COLLECTION', 'COMPONENT', 'SCREEN'] })],
    ['an element type of another list', withScope({ elementTypes: ['REPORT'] })],
    ['an empty screenIds', withScope({ elementTypes: ['SCREEN'], screenIds: [] })],
    ['501 screenIds', withScope({ elementTypes: ['SCREEN'], screenIds: Array.from({ length: 501 }, (_, i) => i + 1) })],
    ['a screenId of 0', withScope({ elementTypes: ['SCREEN'], screenIds: [0] })],
    ['an empty documentationStatus', withScope({ elementTypes: ['SCREEN'], documentationStatus: [] })],
    ['an unknown status', withScope({ elementTypes: ['SCREEN'], documentationStatus: ['DONE'] })],
    ['an unknown scope field', withScope({ elementTypes: ['SCREEN'], format: 'PDF' })],
    ['an unknown field of the request', { ...base, status: 'READY' }],
  ];
  for (const [name, body] of rejected) {
    it(`POST /reports/pdf rejects ${name}`, async () => {
      assert.equal((await send('post', '/reports/pdf', body)).status, 400);
    });
  }

  for (const [name, body] of [
    ['a text of only whitespace', { text: '  \n\t ' }],
    ['an empty text', { text: '' }],
    ['a text of 4001 characters', { text: 'x'.repeat(4001) }],
    ['a review decision', { text: 'ok', reviewDecision: 'APPROVE' }],
  ] as [string, unknown][]) {
    it(`POST /screens/{id}/comments rejects ${name}`, async () => {
      assert.equal((await send('post', '/screens/7/comments', body)).status, 400);
    });
  }

  it('a comment keeps its spaces: leading and trailing whitespace is valid', async () => {
    assert.equal((await send('put', '/comments/31', { text: '  hello  ' })).status, 200);
  });

  it('PUT /reports/{id}/publication rejects a body without isPublished and a non-boolean', async () => {
    assert.equal((await send('put', '/reports/12/publication', {})).status, 400);
    assert.equal((await send('put', '/reports/12/publication', { isPublished: 'yes' })).status, 400);
  });
});

describe('contract: the schemas of Modules 9 to 11 reject what is not theirs', () => {
  const report = {
    id: 12,
    applicationId: 1,
    title: 'Report',
    format: 'PDF',
    status: 'READY',
    isPublished: true,
    fileName: 'report-2026-11-14.pdf',
    fileSize: 100,
    errorMessage: null,
    generatedBy: { id: 2, name: 'Camila' },
    createdAt: '2026-11-14T15:30:00.000Z',
    updatedAt: '2026-11-14T15:31:00.000Z',
    completedAt: '2026-11-14T15:31:00.000Z',
    publishedAt: '2026-11-14T15:31:00.000Z',
  };
  const detail = { ...report, parameters: { format: 'PDF', scope: { elementTypes: ['SCREEN'] }, publish: true } };
  const comment = {
    id: 31,
    screenId: 7,
    author: { id: 3, name: 'Ana' },
    text: 'Hello',
    reviewDecision: null,
    createdAt: '2026-11-12T09:00:00.000Z',
    updatedAt: null,
  };
  const summary = {
    application: { id: 1, name: 'SAR' },
    counts: { screens: 1, variables: 0, collections: 0, components: 0 },
    approvedPercent: 0,
    appContextScreen: {
      id: 1,
      name: 'App (OnStart)',
      documentationStatus: 'DRAFT',
      miroLink: null,
      template: {
        onStart: null,
        workingProcess: null,
        architecture: null,
        dataModel: null,
        requirements: null,
        knownIssues: null,
        risks: null,
      },
    },
    keyScreens: [],
    globalVariables: [],
    topComponents: [],
  };

  const accepts = (method: string, url: string, status: number, body: unknown) =>
    assertConformsToContract({ status, body, request: call(method, url) });
  const rejects = (method: string, url: string, status: number, body: unknown) =>
    assert.rejects(accepts(method, url, status, body));
  const one = (data: unknown) => ({ data });
  const page = (data: unknown[]) => ({ data, page: 1, pageSize: 20, total: data.length });

  it('a report as the contract describes it is accepted (the control of these cases)', async () => {
    await accepts('PUT', '/reports/12/publication', 200, one(report));
    await accepts('GET', '/reports/12', 200, one(detail));
    await accepts('GET', '/reports?applicationId=1', 200, page([report]));
    await accepts('GET', '/screens/7/comments', 200, page([comment]));
    await accepts('GET', '/onboarding/summary?applicationId=1', 200, one(summary));
  });

  it('a report with a field of the contract left out or added', async () => {
    const { updatedAt, ...withoutUpdatedAt } = report;
    assert.ok(updatedAt);
    await rejects('PUT', '/reports/12/publication', 200, one(withoutUpdatedAt));
    await rejects('PUT', '/reports/12/publication', 200, one({ ...report, parameters: detail.parameters }));
    await rejects('GET', '/reports?applicationId=1', 200, page([{ ...report, extra: 1 }]));
  });

  it('the detail of a report without its parameters, or with an unknown one', async () => {
    await rejects('GET', '/reports/12', 200, one(report));
    await rejects('GET', '/reports/12', 200, one({ ...detail, extra: true }));
  });

  it('an errorMessage that is not one of the four texts', async () => {
    await rejects(
      'GET',
      '/reports/12',
      200,
      one({ ...detail, status: 'FAILED', errorMessage: 'connect ECONNREFUSED 10.0.0.1:5432' }),
    );
    await accepts(
      'GET',
      '/reports/12',
      200,
      one({
        ...detail,
        status: 'FAILED',
        errorMessage: "The report couldn't be generated. Try again in a few minutes.",
      }),
    );
  });

  it('a file name with a quote, a path separator or an uppercase letter', async () => {
    for (const fileName of ['a"b.pdf', '../a.pdf', 'Report.pdf', '-a.pdf']) {
      await rejects('PUT', '/reports/12/publication', 200, one({ ...report, fileName }));
    }
  });

  it('a status and a format that are not in their lists', async () => {
    await rejects('PUT', '/reports/12/publication', 200, one({ ...report, status: 'DONE' }));
    await rejects('PUT', '/reports/12/publication', 200, one({ ...report, format: 'DOCX' }));
  });

  it('a comment with a field that is not its own', async () => {
    await rejects('GET', '/screens/7/comments', 200, page([{ ...comment, isEdited: false }]));
    await rejects('GET', '/screens/7/comments', 200, page([{ ...comment, reviewDecision: 'DONE' }]));
  });

  it('a Location is not declared on the 201 of a comment, and a 412 is declared for the edit', () => {
    const created = contract.paths['/screens/{id}/comments']!.post!.responses['201'] as { headers?: object };
    assert.equal('Location' in (created.headers ?? {}), false);
    assert.ok('412' in contract.paths['/comments/{id}']!.put!.responses);
    assert.ok('412' in contract.paths['/reports/{id}/publication']!.put!.responses);
  });

  it('a status the operation does not declare', async () => {
    await rejects('PUT', '/reports/12/publication', 422, { code: 'REPORT_NOT_READY', message: 'x', details: null });
    await rejects('POST', '/screens/7/comments', 409, { code: 'DUPLICATE_NAME', message: 'x', details: null });
  });

  it('an onboarding summary beyond its limits or with a field that does not belong', async () => {
    const screen = {
      screen: { id: 3, name: 'Inicio' },
      documentationStatus: 'DRAFT',
      connections: 1,
      depth: 1,
      miroLink: null,
    };
    const url = '/onboarding/summary?applicationId=1';
    await accepts('GET', url, 200, one({ ...summary, keyScreens: Array.from({ length: 10 }, () => screen) }));
    await rejects('GET', url, 200, one({ ...summary, keyScreens: Array.from({ length: 11 }, () => screen) }));
    await rejects('GET', url, 200, one({ ...summary, keyScreens: [{ ...screen, depth: 0 }] }));
    await accepts('GET', url, 200, one({ ...summary, keyScreens: [{ ...screen, depth: null }] }));
    await rejects('GET', url, 200, one({ ...summary, keyScreens: [{ ...screen, approved: true }] }));
    await rejects(
      'GET',
      url,
      200,
      one({ ...summary, topComponents: [{ component: { id: 1, name: 'c' }, screen: screen.screen, uses: 0 }] }),
    );
    await rejects('GET', url, 200, one({ ...summary, approvedPercent: 100.5 }));
    const variable = { variable: { id: 1, name: 'g' }, dataType: 'TEXT', originScreen: null, usedByScreens: 2 };
    await rejects('GET', url, 200, one({ ...summary, globalVariables: Array.from({ length: 11 }, () => variable) }));
    const { template, ...withoutTemplate } = summary.appContextScreen;
    assert.ok(template);
    await rejects('GET', url, 200, one({ ...summary, appContextScreen: withoutTemplate }));
  });
});
