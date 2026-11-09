/** Mapping of Jira data and the ADF description (SRS 3.9.3, SDD Table 23). */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDescription } from '../../src/integrations/jira/adf.js';
import { JiraProtocolError } from '../../src/integrations/jira/errors.js';
import { mapHierarchyLevel, mapStatusCategory, parseIssue } from '../../src/integrations/jira/mapping.js';

const rawIssue = (over: Record<string, unknown> = {}): unknown => ({
  id: '10003',
  key: 'TECHEA-3',
  fields: {
    summary: 'Validar el correo',
    status: { name: 'En curso', statusCategory: { key: 'indeterminate' } },
    issuetype: { name: 'Subtask', hierarchyLevel: -1 },
    parent: { id: '10002', key: 'TECHEA-2' },
    ...over,
  },
});

describe('status category and hierarchy level', () => {
  it('maps new / indeterminate / done', () => {
    assert.equal(mapStatusCategory('new'), 'TO_DO');
    assert.equal(mapStatusCategory('indeterminate'), 'IN_PROGRESS');
    assert.equal(mapStatusCategory('done'), 'DONE');
  });

  it('maps 1 / 0 / -1', () => {
    assert.equal(mapHierarchyLevel(1), 'EPIC');
    assert.equal(mapHierarchyLevel(0), 'STANDARD');
    assert.equal(mapHierarchyLevel(-1), 'SUBTASK');
  });

  it('rejects what is not modelled', () => {
    for (const v of ['undefined', 'NEW', null, 2]) {
      assert.throws(() => mapStatusCategory(v), JiraProtocolError);
    }
    for (const v of [2, -2, '1', null]) {
      assert.throws(() => mapHierarchyLevel(v), JiraProtocolError);
    }
  });
});

describe('parseIssue', () => {
  it('reads id, key, summary, status with category, type with level, and parent', () => {
    assert.deepEqual(parseIssue(rawIssue()), {
      id: '10003',
      key: 'TECHEA-3',
      summary: 'Validar el correo',
      status: 'En curso',
      statusCategory: 'IN_PROGRESS',
      issueType: 'Subtask',
      hierarchyLevel: 'SUBTASK',
      parent: { id: '10002', key: 'TECHEA-2' },
    });
  });

  it('has no parent when Jira sends none', () => {
    const issue = parseIssue(rawIssue({ parent: undefined, issuetype: { name: 'Epic', hierarchyLevel: 1 } }));
    assert.equal(issue.parent, null);
    assert.equal(issue.hierarchyLevel, 'EPIC');
  });

  it('rejects malformed issues', () => {
    for (const bad of [null, [], {}, { id: '1', key: 'A-1' }, rawIssue({ summary: '' }), rawIssue({ status: {} })]) {
      assert.throws(() => parseIssue(bad), JiraProtocolError);
    }
  });
});

describe('buildDescription (ADF)', () => {
  const screen = { screenId: 7, screenName: 'Login', applicationName: 'SAR' };

  it('makes one paragraph per non-empty line and ends with the screen reference', () => {
    const doc = buildDescription('First line\r\n\r\n  Second line  \n', screen);
    assert.equal(doc.type, 'doc');
    assert.equal(doc.version, 1);
    assert.deepEqual(
      doc.content.map((p) => p.content[0]?.text),
      ['First line', 'Second line', 'Source screen: Login (SAR) · screen id 7'],
    );
  });

  it('contains only the reference without a description, and never an empty text node', () => {
    for (const d of [undefined, '', '  \n ']) {
      const doc = buildDescription(d, screen);
      assert.equal(doc.content.length, 1);
      assert.ok(doc.content.every((p) => p.content.every((t) => t.text !== '')));
    }
  });
});
