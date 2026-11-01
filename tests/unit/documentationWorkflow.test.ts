/**
 * Pure rules of the documentation status after creating or editing a screen (D-81, SDD Table 61). The transitions of
 * /status and /review are covered by the legacy test 06.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  TEMPLATE_FIELDS,
  hasContent,
  initialStatus,
  statusAfterEdit,
  type DocStatus,
  type TemplateContent,
} from '../../src/modules/screens/documentationWorkflow.js';

const empty = (): TemplateContent => ({
  onStart: null,
  workingProcess: null,
  architecture: null,
  dataModel: null,
  requirements: null,
  knownIssues: null,
  risks: null,
});
const with_ = (over: Partial<Record<(typeof TEMPLATE_FIELDS)[number], string | null>>): TemplateContent => ({
  ...empty(),
  ...over,
});

describe('hasContent (D-81)', () => {
  it('null, undefined, empty and blank text have no content', () => {
    for (const value of [null, undefined, '', ' ', '\n\t  ']) assert.equal(hasContent(value), false, String(value));
  });
  it('any text with a visible character has content', () => {
    for (const value of ['a', ' a ', '0', '-']) assert.equal(hasContent(value), true, value);
  });
});

describe('initialStatus (D-81)', () => {
  it('is UNDOCUMENTED without content and DRAFT with content in any single field', () => {
    assert.equal(initialStatus(empty()), 'UNDOCUMENTED');
    assert.equal(initialStatus(with_({ onStart: '  ', risks: '' })), 'UNDOCUMENTED');
    for (const field of TEMPLATE_FIELDS) assert.equal(initialStatus(with_({ [field]: 'x' })), 'DRAFT', field);
  });
});

describe('statusAfterEdit (D-81)', () => {
  const filled = with_({ onStart: 'text' });

  it('UNDOCUMENTED becomes DRAFT when a field goes from no content to content', () => {
    for (const field of TEMPLATE_FIELDS) {
      assert.equal(
        statusAfterEdit('UNDOCUMENTED', { before: empty(), after: with_({ [field]: 'x' }), changed: true }),
        'DRAFT',
        field,
      );
    }
  });
  it('UNDOCUMENTED stays when the edit adds no content (name, links, blank text)', () => {
    assert.equal(statusAfterEdit('UNDOCUMENTED', { before: empty(), after: empty(), changed: true }), 'UNDOCUMENTED');
    assert.equal(
      statusAfterEdit('UNDOCUMENTED', { before: empty(), after: with_({ risks: '   ' }), changed: true }),
      'UNDOCUMENTED',
    );
  });
  it('UNDOCUMENTED that already has content (moved back) stays when it is only modified', () => {
    assert.equal(
      statusAfterEdit('UNDOCUMENTED', { before: filled, after: with_({ onStart: 'other' }), changed: true }),
      'UNDOCUMENTED',
    );
  });
  it('APPROVED becomes IN_PROGRESS on any real change, even outside the template', () => {
    assert.equal(statusAfterEdit('APPROVED', { before: filled, after: filled, changed: true }), 'IN_PROGRESS');
  });
  it('a PUT without changes never moves the status', () => {
    const all: DocStatus[] = ['UNDOCUMENTED', 'DRAFT', 'IN_PROGRESS', 'IN_REVIEW', 'APPROVED'];
    for (const status of all) {
      assert.equal(
        statusAfterEdit(status, { before: empty(), after: with_({ onStart: 'x' }), changed: false }),
        status,
      );
    }
  });
  it('DRAFT and IN_PROGRESS keep their status when edited', () => {
    for (const status of ['DRAFT', 'IN_PROGRESS'] as const) {
      assert.equal(statusAfterEdit(status, { before: empty(), after: filled, changed: true }), status);
    }
  });
});
