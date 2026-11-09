/** Unit tests of the search normalization and of the LIKE pattern (FR-17; D-105 a). No database needed. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  NORMALIZATION_PAIRS,
  SQL_FROM,
  SQL_TO,
  containsPattern,
  normalizeText,
} from '../../src/modules/search/text.js';

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

describe('search LIKE pattern', () => {
  it('finds the text anywhere and escapes %, _ and the backslash so they are ordinary characters', () => {
    assert.equal(containsPattern('abc'), '%abc%');
    assert.equal(containsPattern('100%'), '%100\\%%');
    assert.equal(containsPattern('a_b'), '%a\\_b%');
    assert.equal(containsPattern('a\\b'), '%a\\\\b%');
    assert.equal(containsPattern('%_'), '%\\%\\_%');
  });
});
