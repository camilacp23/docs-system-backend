/**
 * Reference ("golden") responses: a response is stored once as a JSON file and every later run must give the same one.
 *
 * Only what changes between runs is normalized: every integer under a key `id` or ending in `Id` becomes `#n`, `n`
 * being the order of first appearance of that value in the document (so the same row keeps the same label wherever it
 * appears), every `createdAt` / `updatedAt` becomes `<date>` and the ETag becomes `<etag>` (its shape is still checked).
 * Everything else, the order of every array included, is compared as the API sends it.
 *
 * To record or refresh the references on purpose: `UPDATE_GOLDEN=1 npm run test:integration -- <file>`.
 *
 * @module tests/helpers/golden
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'integration', 'golden');

const ID_KEY = /^(id|.+Id)$/;
const DATE_KEY = /^(createdAt|updatedAt)$/;

/** Returns a copy of `value` with the ids, the dates and nothing else replaced (see the module comment). */
export function normalizeJson(value: unknown): unknown {
  const labels = new Map<number, string>();
  const walk = (node: unknown, key: string | undefined): unknown => {
    if (Array.isArray(node)) return node.map((item) => walk(item, undefined));
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v, k)]));
    }
    if (typeof node === 'number' && Number.isInteger(node) && key !== undefined && ID_KEY.test(key)) {
      if (!labels.has(node)) labels.set(node, `#${labels.size + 1}`);
      return labels.get(node);
    }
    if (typeof node === 'string' && key !== undefined && DATE_KEY.test(key)) return '<date>';
    return node;
  };
  return walk(value, undefined);
}

/** The parts of a supertest response a reference keeps. */
type Captured = { status: number; headers: Record<string, unknown>; body: unknown };

/**
 * Compares a response with its stored reference (or stores it when `UPDATE_GOLDEN=1`).
 *
 * @param name - File name of the reference, without extension.
 * @param res - The response; its ETag must be present and look like a quoted entity tag.
 */
export function assertMatchesGolden(name: string, res: Captured): void {
  const etag = res.headers.etag;
  assert.match(String(etag), /^W?\/?"[^"]+"$/, `${name}: the response has no well-formed ETag`);
  const actual = { status: res.status, etag: '<etag>', body: normalizeJson(res.body) };
  const file = join(GOLDEN_DIR, `${name}.json`);
  if (process.env.UPDATE_GOLDEN === '1') {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`, 'utf8');
    return;
  }
  assert.ok(existsSync(file), `${name}: reference ${file} does not exist (UPDATE_GOLDEN=1 records it)`);
  assert.deepEqual(
    actual,
    JSON.parse(readFileSync(file, 'utf8')) as unknown,
    `${name}: the response differs from its reference`,
  );
}
