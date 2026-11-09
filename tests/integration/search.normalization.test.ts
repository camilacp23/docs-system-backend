/**
 * Module 6, the normalization is the same in SQL and in TypeScript (D-105 a): the `translate()` that PostgreSQL runs is
 * compared with `normalizeText` over every character of the map, the characters around it and some others. The two
 * are generated from the same list of pairs, and this test proves that PostgreSQL agrees.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Prisma } from '../../src/generated/prisma/client.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { NORMALIZATION_PAIRS, normalizeText, normalizedSql } from '../../src/modules/search/text.js';

/** Every code point from U+0001 to U+024F (Latin) except the surrogates, plus samples of other scripts. */
function samples(): string[] {
  const list: string[] = [];
  for (let code = 1; code <= 0x24f; code += 1) list.push(String.fromCodePoint(code));
  list.push(...NORMALIZATION_PAIRS.flatMap(([from, to]) => [from, to]));
  list.push(...['Σ', 'σ', 'Ж', 'ж', 'Ç', 'ç', 'İ', 'ı', 'ß', '😀', '\r\n', 'ÁÉÍÓÚÜ áéíóúü ÑñNn', 'Año_100% a\\b']);
  list.push('Configuración ÓPTIMA Pingüino ÑANDÚ', 'x😀Á😀y', '');
  return list;
}

describe('search: SQL and TypeScript normalize alike', () => {
  let t: TestApp;
  before(async () => {
    t = await startTestApp();
  });
  after(async () => {
    await t.close();
  });

  it('gives the same text for every character of the map and every sample', async () => {
    const inputs = samples();
    const rows = await t.db.base.$queryRaw<{ out: string }[]>(
      Prisma.sql`SELECT ${normalizedSql(Prisma.sql`s.v`)} AS out
                   FROM unnest(${inputs}::text[]) WITH ORDINALITY AS s(v, n) ORDER BY s.n`,
    );
    assert.equal(rows.length, inputs.length);
    inputs.forEach((input, i) => {
      assert.equal(
        rows[i]!.out,
        normalizeText(input),
        `U+${[...input].map((c) => c.codePointAt(0)!.toString(16)).join(' U+')}`,
      );
    });
  });

  it('covers every pair of the map: each source character maps to its target in PostgreSQL', async () => {
    const froms = NORMALIZATION_PAIRS.map(([from]) => from);
    const rows = await t.db.base.$queryRaw<{ out: string }[]>(
      Prisma.sql`SELECT ${normalizedSql(Prisma.sql`s.v`)} AS out FROM unnest(${froms}::text[]) WITH ORDINALITY AS s(v, n) ORDER BY s.n`,
    );
    assert.deepEqual(
      rows.map((r) => r.out),
      NORMALIZATION_PAIRS.map(([, to]) => to),
    );
  });
});
