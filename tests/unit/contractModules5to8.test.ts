/**
 * Modules 5 to 8 (FR-15 to FR-21): the response examples of the contract match the contract's own response schemas
 * once they go through the same validator the API uses, and the variants (`oneOf` with `discriminator`) reject a field
 * that does not belong to them. Unit test: no database and no server.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { DEFAULT_OPENAPI_PATH } from '../../src/app.js';
import { assertConformsToContract } from '../helpers/contractResponse.js';

type Example = { value: unknown };
type Operation = {
  responses: Record<string, { content?: { 'application/json': { examples?: Record<string, Example> } } }>;
};
type Contract = { paths: Record<string, Record<string, Operation>> };

const contract = parse(readFileSync(DEFAULT_OPENAPI_PATH, 'utf8')) as Contract;

/** The 200 examples of one operation, by name. */
const examplesOf = (path: string): [string, unknown][] =>
  Object.entries(contract.paths[path]!.get!.responses['200']!.content!['application/json'].examples ?? {}).map(
    ([name, e]) => [name, e.value],
  );

const call = (url: string) => ({ method: 'GET', url: `http://localhost/api/v1${url}` });

const OPERATIONS: [string, string][] = [
  ['/dependencies/graph', '/dependencies/graph?applicationId=2'],
  ['/dependencies/{type}/{id}', '/dependencies/collections/21?depth=1'],
  ['/search', '/search?applicationId=2&q=filter'],
  ['/dashboard/indicators', '/dashboard/indicators?applicationId=2'],
  ['/audit-log', '/audit-log?applicationId=2'],
];

describe('contract: the examples of Modules 5 to 8 conform to their schemas', () => {
  for (const [path, url] of OPERATIONS) {
    const examples = examplesOf(path);
    it(`${path} has examples`, () => {
      assert.ok(examples.length > 0);
    });
    for (const [name, value] of examples) {
      it(`${path}: ${name}`, async () => {
        await assertConformsToContract({ status: 200, body: value, request: call(url) });
      });
    }
  }
});

describe('contract: a variant rejects what is not its own', () => {
  const graph = (nodes: unknown[], edges: unknown[] = []) => ({ data: { nodes, edges } });
  const rejects = async (url: string, body: unknown) => {
    await assert.rejects(assertConformsToContract({ status: 200, body, request: call(url) }));
  };
  const graphUrl = '/dependencies/graph?applicationId=2';

  it('a node with a field of another type', async () => {
    await rejects(graphUrl, graph([{ key: 'collection:1', id: 1, type: 'COLLECTION', name: 'c', scope: 'GLOBAL' }]));
  });
  it('a variable without untraced', async () => {
    await rejects(graphUrl, graph([{ key: 'variable:1', id: 1, type: 'VARIABLE', name: 'v', scope: 'GLOBAL' }]));
  });
  it('a field that does not apply is absent, not null', async () => {
    await rejects(
      graphUrl,
      graph([{ key: 'component:1', id: 1, type: 'COMPONENT', name: 'c', screenId: 3, miroLink: null }]),
    );
  });
  it('an ACCESSES edge without accessMode', async () => {
    await rejects(
      graphUrl,
      graph([], [{ id: 'sc:1', source: 'screen:1', target: 'collection:1', kind: 'ACCESSES', usedIn: 'OnVisible' }]),
    );
  });
  it('a CONTAINS edge with accessMode', async () => {
    await rejects(
      graphUrl,
      graph([], [{ id: 'ct:1', source: 'screen:1', target: 'component:1', kind: 'CONTAINS', accessMode: 'READ' }]),
    );
  });
  it('a search result of a component without its screen', async () => {
    await rejects('/search?applicationId=2&q=bt', {
      data: [{ type: 'COMPONENT', id: 1, name: 'btn', matchedIn: 'name', snippet: null }],
      page: 1,
      pageSize: 20,
      total: 1,
    });
  });
  it('matchedIn outside the list of the type', async () => {
    await rejects('/search?applicationId=2&q=bt', {
      data: [{ type: 'SCREEN', id: 1, name: 's', matchedIn: 'onSelect', snippet: null, documentationStatus: 'DRAFT' }],
      page: 1,
      pageSize: 20,
      total: 1,
    });
  });
  it('recentActivity with values', async () => {
    await rejects('/dashboard/indicators?applicationId=2', {
      data: {
        documentation: {
          totalScreens: 1,
          byStatus: { UNDOCUMENTED: 1, DRAFT: 0, IN_PROGRESS: 0, IN_REVIEW: 0, APPROVED: 0 },
          approvedPercent: 0,
        },
        variables: { total: 0, untraced: 0 },
        collections: { total: 0, undocumented: 0 },
        jira: { pendingSubtasks: 0, jiraAvailable: true, lastSyncedAt: null },
        recentActivity: [
          {
            actor: null,
            action: 'CREATE',
            eventName: null,
            entityType: 'screen',
            entityId: '1',
            entityLabel: 's',
            createdAt: '2026-11-08T00:00:00.000Z',
            newValue: {},
          },
        ],
      },
    });
  });
});
