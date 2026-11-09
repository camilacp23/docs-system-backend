/** Unit tests of the oracle of the search order (D-105 f). No database needed. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareCodePoints, resultComparator } from '../helpers/searchOrder.js';

const sorted = (names: string[]): string[] =>
  names
    .map((name, id) => ({ type: 'VARIABLE', id, name }))
    .sort(resultComparator(undefined))
    .map((r) => r.name);

describe('search order oracle', () => {
  it('compares by code point, not by UTF-16 unit', () => {
    assert.ok(compareCodePoints('～', '😀') < 0, 'U+FF5E is before U+1F600 by code point');
    assert.ok('😀' < '～', 'the premise: by UTF-16 unit it is the other way round');
    assert.equal(compareCodePoints('abc', 'abc'), 0);
    assert.ok(compareCodePoints('ab', 'abc') < 0);
  });

  it('puts digits and the underscore before the letters, and ñ and accents outside A-Z after z', () => {
    assert.deepEqual(sorted(['Zeta', 'alpha', 'Álamo', '_under', '9x', '10x', 'ñandú', 'Beta']), [
      '10x',
      '9x',
      '_under',
      'Álamo',
      'alpha',
      'Beta',
      'Zeta',
      'ñandú',
    ]);
  });

  it('ignores case and accents in the name, then breaks ties by type and id', () => {
    const list = [
      { type: 'COMPONENT', id: 1, name: 'Alpha' },
      { type: 'SCREEN', id: 9, name: 'alpha' },
      { type: 'VARIABLE', id: 5, name: 'ALPHA' },
      { type: 'VARIABLE', id: 2, name: 'alpha' },
    ];
    assert.deepEqual(
      list.sort(resultComparator(undefined)).map((r) => `${r.type}:${r.id}`),
      ['SCREEN:9', 'VARIABLE:2', 'VARIABLE:5', 'COMPONENT:1'],
    );
  });

  it('puts the exact name match first only when there is a text', () => {
    const list = [
      { type: 'VARIABLE', id: 1, name: 'aaalpha' },
      { type: 'VARIABLE', id: 2, name: 'Alpha' },
    ];
    assert.deepEqual(
      [...list].sort(resultComparator('ALPHA')).map((r) => r.name),
      ['Alpha', 'aaalpha'],
    );
    assert.deepEqual(
      [...list].sort(resultComparator(undefined)).map((r) => r.name),
      ['aaalpha', 'Alpha'],
    );
  });
});
