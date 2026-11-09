/** Unit tests of the search normalization and of the regular expression (FR-17; D-105 a). No database needed. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NORMALIZATION_PAIRS, SQL_FROM, SQL_TO, matchPattern, normalizeText } from '../../src/modules/search/text.js';

describe('search normalization', () => {
  it('is one to one: every character is mapped once and every pair is one UTF-16 unit on each side', () => {
    const from = NORMALIZATION_PAIRS.map(([f]) => f);
    assert.equal(new Set(from).size, from.length, 'a character is mapped twice');
    for (const [f, t] of NORMALIZATION_PAIRS) {
      assert.equal(f.length, 1, f);
      assert.equal(t.length, 1, t);
    }
    assert.equal(SQL_FROM.length, SQL_TO.length);
    assert.equal(SQL_FROM.length, NORMALIZATION_PAIRS.length);
  });

  it('ignores case and the accents of the vowels, also the diaeresis, in both cases', () => {
    assert.equal(normalizeText('Configuración'), 'configuracion');
    assert.equal(normalizeText('CONFIGURACIÓN'), 'configuracion');
    assert.equal(normalizeText('ÁÉÍÓÚÜ áéíóúü'), 'aeiouu aeiouu');
    assert.equal(normalizeText('Pingüino'), 'pinguino');
  });

  it('keeps ñ different from n, and ñ equal to Ñ', () => {
    assert.notEqual(normalizeText('año'), normalizeText('ano'));
    assert.equal(normalizeText('AÑO'), normalizeText('año'));
    assert.equal(normalizeText('Ñ'), 'ñ');
  });

  it('leaves the other characters alone: other alphabets and other accents are distinguished', () => {
    for (const text of ['Ç', 'ç', 'Σ', 'σ', 'à', 'ê', '_', '%', '1', ' ', '\r\n', '😀']) {
      assert.equal(normalizeText(text), text, text);
    }
    assert.notEqual(normalizeText('Σ'), normalizeText('σ'));
  });

  it('keeps the length, also for a character whose lowercase would expand ("İ")', () => {
    assert.equal('İ'.toLowerCase().length, 2, 'the premise: toLowerCase expands it');
    for (const text of ['İ', 'İİ ÁÑ', '😀Á😀', 'a\r\nB']) assert.equal(normalizeText(text).length, text.length, text);
    assert.equal(normalizeText('İ'), 'İ');
  });
});

/** The JavaScript twin of an expression of `matchPattern`: `\UXXXXXXXX` is written `\u{XXXXXXXX}` there. */
const toJs = (pattern: string): RegExp => new RegExp(pattern.replace(/\\U([0-9a-f]{8})/g, '\\u{$1}'), 'u');

const METACHARACTERS = ['.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|', '^', '$', '\\', '-'];
const OTHER_SYMBOLS = [
  '%',
  '_',
  "'",
  '"',
  '/',
  '&',
  '~',
  '@',
  '#',
  '!',
  ',',
  ':',
  ';',
  '<',
  '>',
  '=',
  '\n',
  '\r',
  '\t',
];

describe('search regular expression', () => {
  it('turns each character of the query into the class generated from the pairs', () => {
    assert.equal(matchPattern('i'), '[iI\\u00ed\\u00cd]');
    assert.equal(matchPattern('ñ'), '[\\u00f1\\u00d1]');
    assert.equal(matchPattern('u'), '[uU\\u00fa\\u00fc\\u00da\\u00dc]');
    assert.equal(matchPattern('7'), '7');
    assert.equal(matchPattern('ab'), '[aA\\u00e1\\u00c1][bB]');
  });

  it('has a class for every pair: the class of a target holds exactly what normalizes to it', () => {
    for (const [from, to] of NORMALIZATION_PAIRS) {
      assert.ok(toJs(matchPattern(to)).test(from), `${to} should match ${from}`);
    }
    const everything = Array.from({ length: 0x250 }, (_, i) => String.fromCodePoint(i));
    for (const target of new Set(NORMALIZATION_PAIRS.map(([, to]) => to))) {
      const pattern = toJs(`^${matchPattern(target)}$`);
      for (const c of everything) {
        assert.equal(pattern.test(c), normalizeText(c) === target, `${JSON.stringify(c)} against ${target}`);
      }
    }
  });

  it('writes every metacharacter as a hexadecimal escape, never raw, so it is literal', () => {
    for (const c of [...METACHARACTERS, ...OTHER_SYMBOLS]) {
      const pattern = matchPattern(c);
      assert.equal(pattern, `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`, JSON.stringify(c));
      assert.ok(toJs(pattern).test(c), JSON.stringify(c));
      assert.ok(!toJs(pattern).test('x'), JSON.stringify(c));
    }
  });

  it('keeps the metacharacters literal inside a longer query and next to classes', () => {
    const query = 'a.b*c+d?(e)[f]{g}|h^i$j\\k-l%m_n';
    assert.ok(toJs(matchPattern(normalizeText(query))).test(`xx${query}yy`));
    assert.ok(!toJs(matchPattern('a.b*c')).test('axb*c'), '. is not a wildcard');
    for (const near of ['a.b.c', 'a.bbc', 'a.b*']) assert.ok(!toJs(matchPattern('a.b*c')).test(near), near);
    assert.ok(!toJs(matchPattern('a%b')).test('axxb'), '% is not a wildcard');
    assert.ok(!toJs(matchPattern('a_b')).test('axb'), '_ is not a wildcard');
    assert.ok(toJs(matchPattern('a_b')).test('a_b'));
    assert.ok(!toJs(matchPattern('[ab]')).test('a'), 'a bracket is not a class');
    assert.ok(!toJs(matchPattern('a|b')).test('a'), '| is not an alternative');
    assert.ok(!toJs(matchPattern('^a')).test('a'), '^ is not an anchor');
  });

  it('writes characters outside the Basic Multilingual Plane as one escape, and reads the query by code point', () => {
    assert.equal(matchPattern('😀'), '\\U0001f600');
    assert.ok(toJs(matchPattern('a😀b')).test('xa😀by'));
    assert.ok(!toJs(matchPattern('😀')).test('\uD83D'));
  });

  it('writes only safe characters: plain letters, digits and spaces, escapes, and classes of those', () => {
    const safe = /^(?:[A-Za-z0-9 ]|\\u[0-9a-f]{4}|\\U[0-9a-f]{8}|\[(?:[A-Za-z0-9 ]|\\u[0-9a-f]{4})+\])*$/;
    for (const query of ['hello world', 'Año_100% a\\b [x] (y)', '.*', '😀\r\n', 'İ', 'ÁÉÍÓÚÜ Ñ', '***=x']) {
      assert.match(matchPattern(normalizeText(query)), safe, JSON.stringify(query));
    }
  });
});
