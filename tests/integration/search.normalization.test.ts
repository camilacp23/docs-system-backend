/**
 * Module 6, the comparison is the same in SQL and in TypeScript (D-105 a). Two things are proved against PostgreSQL:
 * the `translate()` that orders and compares names gives what `normalizeText` gives, and the regular expression that
 * searches the long texts (`matchPattern`) matches a text if and only if `normalizeText(text)` contains
 * `normalizeText(query)`. The random cases use a fixed seed that is printed, so a failure can be repeated.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Prisma } from '../../src/generated/prisma/client.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { NORMALIZATION_PAIRS, matchPattern, normalizeText, normalizedSql } from '../../src/modules/search/text.js';

/** The seed of the random cases (printed in the output). */
const SEED = 20261109;
const RANDOM_CASES = 1500;

/** Every code point from U+0001 to U+024F (Latin) except the surrogates, plus samples of other scripts. */
function samples(): string[] {
  const list: string[] = [];
  for (let code = 1; code <= 0x24f; code += 1) list.push(String.fromCodePoint(code));
  list.push(...NORMALIZATION_PAIRS.flatMap(([from, to]) => [from, to]));
  list.push(...['Σ', 'σ', 'Ж', 'ж', 'Ç', 'ç', 'İ', 'ı', 'ß', '😀', '\r\n', 'ÁÉÍÓÚÜ áéíóúü ÑñNn', 'Año_100% a\\b']);
  list.push('Configuración ÓPTIMA Pingüino ÑANDÚ', 'x😀Á😀y', '');
  return list;
}

/** A small deterministic generator (mulberry32). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The characters the random cases draw from: metacharacters, % and _, ñ, İ, emoji, line breaks and the map. */
const POOL = [
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  ...'áéíóúüÁÉÍÓÚÜñÑ',
  ...'.*+?()[]{}|^$\\-%_ \'"/&~@#!,:;<>=',
  'İ',
  'ı',
  'Σ',
  'σ',
  'Ç',
  'ç',
  '😀',
  '🎉',
  '\r\n',
  '\n',
  '\t',
];

/** A character written differently but equal after normalization (another case or accent), when there is one. */
function variantOf(character: string, next: () => number): string {
  const target = normalizeText(character);
  const members = [target, ...NORMALIZATION_PAIRS.filter(([, to]) => to === target).map(([from]) => from)];
  return members[Math.floor(next() * members.length)]!;
}

/** The (query, text) pairs: half of the queries are cut from the text (and respelled), half are random. */
function randomCases(): { query: string; text: string }[] {
  const next = random(SEED);
  const pick = (): string => POOL[Math.floor(next() * POOL.length)]!;
  const cases: { query: string; text: string }[] = [];
  while (cases.length < RANDOM_CASES) {
    const text = Array.from({ length: Math.floor(next() * 40) }, pick).join('');
    const units = [...text];
    let query: string;
    if (units.length >= 2 && next() < 0.5) {
      const length = 2 + Math.floor(next() * Math.min(7, units.length - 1));
      const start = Math.floor(next() * (units.length - length + 1));
      query = units
        .slice(start, start + length)
        .map((c) => variantOf(c, next))
        .join('');
    } else {
      query = Array.from({ length: 2 + Math.floor(next() * 4) }, pick).join('');
    }
    // The service trims the query before it reaches the comparison.
    const trimmed = query.trim();
    if ([...trimmed].length >= 2) cases.push({ query: trimmed, text });
  }
  return cases;
}

describe('search: SQL and TypeScript compare alike', () => {
  let t: TestApp;
  before(async () => {
    t = await startTestApp();
  });
  after(async () => {
    await t.close();
  });

  /** For each row, whether `text ~ pattern` in PostgreSQL. */
  async function matches(rows: { pattern: string; text: string }[]): Promise<boolean[]> {
    const result = await t.db.base.$queryRaw<{ matched: boolean }[]>(
      Prisma.sql`SELECT (x.t ~ x.p) AS matched
                   FROM unnest(${rows.map((r) => r.pattern)}::text[], ${rows.map((r) => r.text)}::text[])
                        WITH ORDINALITY AS x(p, t, n) ORDER BY x.n`,
    );
    return result.map((r) => r.matched);
  }

  it('translate() gives the same text as normalizeText for every character of the map and every sample', async () => {
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

  it('the class of every target character matches, in PostgreSQL, exactly the characters that normalize to it', async () => {
    const characters = samples().filter((s) => [...s].length === 1);
    const targets = [...new Set([...NORMALIZATION_PAIRS.map(([, to]) => to), 'n', 'ñ', 'İ', 'ç'])];
    for (const target of targets) {
      const found = await matches(characters.map((text) => ({ pattern: `^${matchPattern(target)}$`, text })));
      characters.forEach((c, i) => {
        assert.equal(found[i], normalizeText(c) === target, `${JSON.stringify(c)} against ${JSON.stringify(target)}`);
      });
    }
  });

  it(`matches if and only if normalizeText(text) contains normalizeText(query): ${RANDOM_CASES} random cases, seed ${SEED}`, async () => {
    console.log(`SEED search regular expression equivalence: ${SEED}, cases: ${RANDOM_CASES}`);
    const cases = randomCases();
    const found = await matches(cases.map((c) => ({ pattern: matchPattern(normalizeText(c.query)), text: c.text })));
    let positives = 0;
    cases.forEach((c, i) => {
      const expected = normalizeText(c.text).includes(normalizeText(c.query));
      if (expected) positives += 1;
      assert.equal(
        found[i],
        expected,
        `seed ${SEED}, case ${i}: query ${JSON.stringify(c.query)}, text ${JSON.stringify(c.text)}`,
      );
    });
    console.log(`SEED cases that match: ${positives}, that do not: ${cases.length - positives}`);
    assert.ok(positives > 100 && cases.length - positives > 100, 'the cases cover both outcomes');
  });

  it('keeps every metacharacter literal in PostgreSQL, also next to a class', async () => {
    const meta = ['.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|', '^', '$', '\\', '-', '%', '_', '\n', '\r\n'];
    const rows = meta.flatMap((c) => [
      { pattern: matchPattern(`a${c}b`), text: `xxA${c}Býy` },
      { pattern: matchPattern(`a${c}b`), text: 'axb' },
      { pattern: matchPattern(`a${c}b`), text: 'ab' },
      { pattern: matchPattern(`${c}${c}`), text: `${c}${c}` },
    ]);
    const found = await matches(rows);
    meta.forEach((c, i) => {
      assert.deepEqual(found.slice(i * 4, i * 4 + 4), [true, false, false, true], JSON.stringify(c));
    });
  });
});
