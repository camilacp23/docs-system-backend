/** http/repeats: positions of repeated values in a payload (D-65). */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { repeatedFields } from '../../src/http/repeats.js';

describe('repeatedFields', () => {
  it('reports every repetition after the first, with its position', () => {
    const fields = repeatedFields(
      ['a', 'b', 'a', 'a'],
      (x) => x,
      (i) => `items[${i}]`,
    );
    assert.deepEqual(
      fields.map((f) => [f.field, f.rule]),
      [
        ['items[2]', 'unique'],
        ['items[3]', 'unique'],
      ],
    );
  });

  it('skips items without a key', () => {
    const fields = repeatedFields(
      [undefined, undefined],
      (x) => x,
      (i) => `x[${i}]`,
    );
    assert.deepEqual(fields, []);
  });
});
