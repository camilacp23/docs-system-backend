/** Unit tests of the search snippet (FR-17; D-105 e). No database needed. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SNIPPET_MAX_LENGTH, buildSnippet } from '../../src/modules/search/snippet.js';
import { normalizeText } from '../../src/modules/search/text.js';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** The invariants of every snippet of a long text. */
function assertSound(snippet: string, needle: string): void {
  assert.ok(snippet.length <= SNIPPET_MAX_LENGTH, `${snippet.length} characters`);
  assert.ok(!LONE_SURROGATE.test(snippet), 'a surrogate pair was cut');
  assert.ok(normalizeText(snippet).includes(normalizeText(needle)), 'the match is not in the snippet');
}

describe('search snippet', () => {
  it('returns a short text whole, also one of exactly 300 characters', () => {
    assert.equal(buildSnippet('Lists the requests.', 'requests'), 'Lists the requests.');
    const exact = `${'a'.repeat(292)}needle  `;
    assert.equal(exact.length, 300);
    assert.equal(buildSnippet(exact, 'needle'), exact);
  });

  it('cuts only the end when the match is at the start', () => {
    const snippet = buildSnippet(`needle${'a'.repeat(1000)}`, 'needle');
    assert.ok(snippet.startsWith('needle'));
    assert.ok(snippet.endsWith('…'));
    assert.equal(snippet.length, SNIPPET_MAX_LENGTH);
  });

  it('cuts only the start when the match is at the end', () => {
    const snippet = buildSnippet(`${'a'.repeat(1000)}needle`, 'needle');
    assert.ok(snippet.startsWith('…'));
    assert.ok(snippet.endsWith('needle'));
    assert.equal(snippet.length, SNIPPET_MAX_LENGTH);
  });

  it('cuts both ends in the middle, around the match', () => {
    const snippet = buildSnippet(`${'a'.repeat(500)}needle${'b'.repeat(500)}`, 'needle');
    assert.ok(snippet.startsWith('…a') && snippet.endsWith('b…'));
    assert.equal(snippet.length, SNIPPET_MAX_LENGTH);
    assertSound(snippet, 'needle');
  });

  it('is built on the original text, found with the normalization (case and accents)', () => {
    const text = `${'x'.repeat(400)}Configuración${'y'.repeat(400)}`;
    const snippet = buildSnippet(text, normalizeText('CONFIGURACION'));
    assert.ok(snippet.includes('Configuración'), 'the original spelling, not the normalized one');
  });

  it('holds for a match at every position of a text just over 300 characters, and of longer ones', () => {
    for (const length of [301, 302, 599, 1000]) {
      for (let at = 0; at <= length - 6; at += 1) {
        const text = `${'a'.repeat(at)}NEEDLE${'b'.repeat(length - at - 6)}`;
        assertSound(buildSnippet(text, 'needle'), 'needle');
      }
    }
  });

  it('holds for the longest query (100 characters) at the edges', () => {
    const needle = 'q'.repeat(100);
    for (const at of [0, 1, 99, 100, 150, 400, 500, 899, 900]) {
      const text = `${'a'.repeat(at)}${needle}${'b'.repeat(1000 - at - 100)}`;
      assertSound(buildSnippet(text, needle), needle);
    }
  });

  it('keeps the positions when a character whose lowercase expands ("İ") comes before the match', () => {
    const text = `${'İ'.repeat(450)}target${'İ'.repeat(450)}`;
    const snippet = buildSnippet(text, 'target');
    assertSound(snippet, 'target');
    assert.ok(snippet.includes('İtargetİ'));
  });

  it('never cuts a surrogate pair (emoji), wherever the window edge falls', () => {
    for (let pad = 0; pad < 4; pad += 1) {
      for (let before = 290; before < 310; before += 1) {
        const text = `${'a'.repeat(pad)}${'😀'.repeat(before)}target${'😀'.repeat(400)}`;
        assertSound(buildSnippet(text, 'target'), 'target');
      }
    }
    assertSound(buildSnippet(`target${'😀'.repeat(400)}`, 'target'), 'target');
    assertSound(buildSnippet(`${'😀'.repeat(400)}target`, 'target'), 'target');
  });

  it('never cuts a \\r\\n sequence, wherever the window edge falls', () => {
    for (let pad = 0; pad < 3; pad += 1) {
      for (let before = 140; before < 160; before += 1) {
        const text = `${'a'.repeat(pad)}${'\r\n'.repeat(before)}target${'\r\n'.repeat(300)}`;
        const snippet = buildSnippet(text, 'target');
        assertSound(snippet, 'target');
        const body = snippet.replace(/^…/, '').replace(/…$/, '');
        assert.ok(!body.startsWith('\n'), 'starts inside a \\r\\n');
        assert.ok(!body.endsWith('\r'), 'ends inside a \\r\\n');
      }
    }
  });
});
