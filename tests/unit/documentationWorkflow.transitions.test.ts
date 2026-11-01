/**
 * Pure rules of `PUT /screens/{id}/status` and `POST /screens/{id}/review` (FR-14, FR-24; SDD Table 61): the whole
 * 5 x 5 matrix of status changes, the template check of a submission and the review decisions.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  TEMPLATE_FIELDS,
  missingTemplateFields,
  planReview,
  planStatusChange,
  type DocStatus,
  type TemplateContent,
} from '../../src/modules/screens/documentationWorkflow.js';

const STATUSES: readonly DocStatus[] = ['UNDOCUMENTED', 'DRAFT', 'IN_PROGRESS', 'IN_REVIEW', 'APPROVED'];

const template = (fill: (field: (typeof TEMPLATE_FIELDS)[number]) => string | null): TemplateContent =>
  Object.fromEntries(TEMPLATE_FIELDS.map((f) => [f, fill(f)])) as TemplateContent;
const complete = template(() => 'text');
const empty = template(() => null);

/** The `/status` rows of Table 61 (the sixth, IN_REVIEW to IN_PROGRESS, is the withdraw). */
const STATUS_ROWS: readonly [DocStatus, DocStatus][] = [
  ['UNDOCUMENTED', 'DRAFT'],
  ['DRAFT', 'UNDOCUMENTED'],
  ['DRAFT', 'IN_PROGRESS'],
  ['IN_PROGRESS', 'DRAFT'],
  ['IN_PROGRESS', 'IN_REVIEW'],
  ['IN_REVIEW', 'IN_PROGRESS'],
  ['APPROVED', 'IN_PROGRESS'],
];

describe('missingTemplateFields (FR-14, D-81)', () => {
  it('lists the fields without content in the order of SRS Table 28, with the names of the contract', () => {
    assert.deepEqual(missingTemplateFields(empty), [
      'onStart',
      'workingProcess',
      'architecture',
      'dataModel',
      'requirements',
      'knownIssues',
      'risks',
    ]);
    assert.deepEqual(missingTemplateFields(complete), []);
  });
  it('null, empty and blank text are missing; any visible character is content', () => {
    const t = { ...complete, risks: '  \n\t ', knownIssues: '', onStart: null, architecture: ' a ' };
    assert.deepEqual(missingTemplateFields(t), ['onStart', 'knownIssues', 'risks']);
  });
});

describe('planStatusChange: the 5 x 5 matrix of Table 61', () => {
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      const allowed = STATUS_ROWS.some(([f, t]) => f === from && t === to);
      it(`${from} -> ${to} is ${allowed ? 'allowed' : 'INVALID_TRANSITION'}`, () => {
        for (const role of ['ADMINISTRATOR', 'DEVELOPER'] as const) {
          // A complete template, so only the matrix decides.
          const outcome = planStatusChange(from, to, role, complete);
          assert.deepEqual(outcome, allowed ? { ok: true, to } : { ok: false, code: 'INVALID_TRANSITION' }, role);
        }
      });
    }
  }

  it('the template is judged only when submitting, and only after the matrix', () => {
    for (const [from, to] of STATUS_ROWS) {
      const outcome = planStatusChange(from, to, 'DEVELOPER', empty);
      if (from === 'IN_PROGRESS' && to === 'IN_REVIEW') {
        assert.equal(outcome.ok, false);
        assert.equal(outcome.ok === false && outcome.code, 'TEMPLATE_INCOMPLETE');
      } else {
        assert.deepEqual(outcome, { ok: true, to }, `${from} -> ${to}`);
      }
    }
    // An invalid combination stays INVALID_TRANSITION even with an incomplete template.
    assert.deepEqual(planStatusChange('DRAFT', 'IN_REVIEW', 'DEVELOPER', empty), {
      ok: false,
      code: 'INVALID_TRANSITION',
    });
  });

  it('TEMPLATE_INCOMPLETE carries the missing fields in the order of Table 28', () => {
    const partial = { ...complete, knownIssues: null, onStart: '   ', risks: '' };
    assert.deepEqual(planStatusChange('IN_PROGRESS', 'IN_REVIEW', 'ADMINISTRATOR', partial), {
      ok: false,
      code: 'TEMPLATE_INCOMPLETE',
      fields: ['onStart', 'knownIssues', 'risks'],
    });
    assert.deepEqual(planStatusChange('IN_PROGRESS', 'IN_REVIEW', 'ADMINISTRATOR', complete), {
      ok: true,
      to: 'IN_REVIEW',
    });
  });

  it('APPROVED is never reachable through /status', () => {
    for (const from of STATUSES) {
      assert.deepEqual(planStatusChange(from, 'APPROVED', 'ADMINISTRATOR', complete), {
        ok: false,
        code: 'INVALID_TRANSITION',
      });
    }
  });

  it('a Reader is refused even on an allowed row (the contract gate comes first)', () => {
    assert.deepEqual(planStatusChange('DRAFT', 'IN_PROGRESS', 'READER', complete), { ok: false, code: 'FORBIDDEN' });
  });
});

describe('planReview: the review rows of Table 61', () => {
  it('APPROVE and RETURN are decided only from IN_REVIEW; any other status is NOT_IN_REVIEW', () => {
    for (const from of STATUSES) {
      const approve = planReview(from, 'APPROVE', 'ADMINISTRATOR', null);
      const ret = planReview(from, 'RETURN', 'ADMINISTRATOR', 'fix it');
      if (from === 'IN_REVIEW') {
        assert.deepEqual(approve, { ok: true, to: 'APPROVED' });
        assert.deepEqual(ret, { ok: true, to: 'IN_PROGRESS' });
      } else {
        assert.deepEqual(approve, { ok: false, code: 'NOT_IN_REVIEW' }, from);
        assert.deepEqual(ret, { ok: false, code: 'NOT_IN_REVIEW' }, from);
      }
    }
  });

  it('NOT_IN_REVIEW goes before COMMENT_REQUIRED', () => {
    assert.deepEqual(planReview('DRAFT', 'RETURN', 'ADMINISTRATOR', '   '), { ok: false, code: 'NOT_IN_REVIEW' });
  });

  it('RETURN needs a comment with content: null, undefined, empty and blank text are COMMENT_REQUIRED', () => {
    for (const comment of [null, undefined, '', '   ', '\n\t']) {
      assert.deepEqual(planReview('IN_REVIEW', 'RETURN', 'ADMINISTRATOR', comment), {
        ok: false,
        code: 'COMMENT_REQUIRED',
      });
    }
    assert.deepEqual(planReview('IN_REVIEW', 'RETURN', 'ADMINISTRATOR', ' x '), { ok: true, to: 'IN_PROGRESS' });
  });

  it('APPROVE does not need a comment', () => {
    for (const comment of [null, undefined, '', '   ', 'good']) {
      assert.deepEqual(planReview('IN_REVIEW', 'APPROVE', 'ADMINISTRATOR', comment), { ok: true, to: 'APPROVED' });
    }
  });

  it('only an Administrator decides', () => {
    for (const role of ['DEVELOPER', 'READER'] as const) {
      assert.deepEqual(planReview('IN_REVIEW', 'APPROVE', role, null), { ok: false, code: 'FORBIDDEN' });
      assert.deepEqual(planReview('IN_REVIEW', 'RETURN', role, 'x'), { ok: false, code: 'FORBIDDEN' });
    }
  });
});
