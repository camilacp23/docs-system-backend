/**
 * The percentage of approved screens (FR-19): one decimal, rounded half up, with exact integer arithmetic. The edge
 * cases are the ones where binary floating point or a different rounding gives another digit.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { approvedPercent } from '../../src/modules/dashboard/percent.js';

describe('dashboard: approvedPercent', () => {
  const cases: [number, number, number][] = [
    [0, 5, 0],
    [5, 5, 100],
    [1, 3, 33.3],
    [2, 3, 66.7],
    [1, 8, 12.5],
    [1, 16, 6.3], // 6.25 rounds half up
    [3, 16, 18.8], // 18.75 rounds half up
    [1, 6, 16.7],
    [1, 1, 100],
    [1, 200, 0.5],
    [1, 400, 0.3], // 0.25 rounds half up
    [1, 3000, 0], // 0.0333 rounds down
    [1, 2000, 0.1], // 0.05 rounds half up
    [999, 1000, 99.9],
    [7, 8, 87.5],
  ];
  for (const [approved, total, expected] of cases) {
    it(`${approved} of ${total} is ${expected}`, () => {
      assert.equal(approvedPercent(approved, total), expected);
    });
  }

  it('is a number with at most one decimal for every fraction of a small total', () => {
    for (let total = 1; total <= 60; total += 1) {
      for (let approved = 0; approved <= total; approved += 1) {
        const value = approvedPercent(approved, total);
        assert.equal(Number(value.toFixed(1)), value, `${approved}/${total}`);
        assert.ok(value >= 0 && value <= 100);
        // The exact value is approved * 100 / total: the rounded tenth is within half a tenth of it.
        assert.ok(Math.abs(value * total - approved * 100) <= 0.05 * total + 1e-9, `${approved}/${total}`);
      }
    }
  });

  it('a total of 0 gives 0 (it never happens: every application has its App (OnStart) screen)', () => {
    assert.equal(approvedPercent(0, 0), 0);
  });
});
