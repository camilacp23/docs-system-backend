/** Representation of the audit history (FR-20, FR-21): the translation to camelCase and the mappers are pure. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  toActivitySummary,
  toAuditEntry,
  toCamelCase,
  translateValue,
  type AuditRow,
} from '../../src/modules/audit/representation.js';

const row = (over: Partial<AuditRow> = {}): AuditRow => ({
  id: 9021n,
  action: 'UPDATE',
  eventName: null,
  entityType: 'screen',
  entityId: '13',
  entityLabel: 'scrDetail',
  applicationId: 2,
  actorId: 5,
  actorName: 'Dani Dev',
  dbRole: 'docs_app',
  changedFields: ['documentation_status', 'known_issues'],
  oldValue: { documentation_status: 'DRAFT', known_issues: null },
  newValue: { documentation_status: 'IN_PROGRESS', known_issues: 'Slow.' },
  createdAt: new Date('2026-11-08T14:52:31.482Z'),
  ...over,
});

describe('audit: toCamelCase', () => {
  it('translates snake_case names', () => {
    assert.equal(toCamelCase('documentation_status'), 'documentationStatus');
    assert.equal(toCamelCase('password_hash'), 'passwordHash');
    assert.equal(toCamelCase('jira_issue_key'), 'jiraIssueKey');
    assert.equal(toCamelCase('id'), 'id');
  });
  it('is idempotent: a camelCase name is unchanged', () => {
    for (const name of ['commentId', 'from', 'documentationStatus', 'to']) assert.equal(toCamelCase(name), name);
    assert.equal(toCamelCase(toCamelCase('known_issues')), 'knownIssues');
  });
});

describe('audit: translateValue', () => {
  it('translates only the first-level keys and leaves every value alone', () => {
    const parameters = { report_format: 'PDF', scope: { element_types: ['SCREEN'], include_dependencies: false } };
    const out = translateValue({ id: 1, generated_by: 3, parameters });
    assert.deepEqual(out, { id: 1, generatedBy: 3, parameters });
    assert.equal(out?.['parameters'], parameters, 'the JSON column is the same object, untouched');
  });
  it('does not touch values that look like names', () => {
    assert.deepEqual(translateValue({ used_in: 'on_visible', note: 'a_b' }), { usedIn: 'on_visible', note: 'a_b' });
  });
  it('null and non-objects give null', () => {
    assert.equal(translateValue(null), null);
    assert.equal(translateValue(undefined), null);
    assert.equal(translateValue(['x']), null);
  });
  it('drops passwordHash only for app_user (safety net)', () => {
    assert.deepEqual(translateValue({ id: 1, name: 'A', password_hash: 'x' }, 'app_user'), { id: 1, name: 'A' });
    assert.deepEqual(translateValue({ passwordHash: 'x', id: 1 }, 'app_user'), { id: 1 });
    assert.deepEqual(translateValue({ password_hash: 'x' }, 'screen'), { passwordHash: 'x' });
  });
});

describe('audit: toAuditEntry', () => {
  it('keeps the table name, serves the id as text and translates keys and changed fields', () => {
    const e = toAuditEntry(row(), true);
    assert.equal(e.id, '9021');
    assert.equal(e.entityType, 'screen');
    assert.deepEqual(e.changedFields, ['documentationStatus', 'knownIssues']);
    assert.deepEqual(e.oldValue, { documentationStatus: 'DRAFT', knownIssues: null });
    assert.equal(e.createdAt, '2026-11-08T14:52:31.482Z');
    assert.deepEqual(e.actor, { id: 5, name: 'Dani Dev' });
  });
  it('dbRole is present for the Administrator and absent (not null) otherwise', () => {
    assert.equal(toAuditEntry(row(), true).dbRole, 'docs_app');
    assert.equal('dbRole' in toAuditEntry(row(), false), false);
  });
  it('the side that does not apply is null, the key stays', () => {
    const create = toAuditEntry(row({ action: 'CREATE', oldValue: null, changedFields: [] }), false);
    assert.equal(create.oldValue, null);
    assert.ok(create.newValue);
    const del = toAuditEntry(row({ action: 'DELETE', newValue: null, changedFields: null }), false);
    assert.equal(del.newValue, null);
    assert.deepEqual(del.changedFields, []);
  });
  it('a write outside the API has no actor', () => {
    assert.equal(toAuditEntry(row({ actorId: null, actorName: null }), true).actor, null);
  });
  it('passwordHash stays in changedFields but has no key in the values', () => {
    const e = toAuditEntry(
      row({
        entityType: 'app_user',
        changedFields: ['password_hash'],
        oldValue: { id: 1, password_hash: 'leak' },
        newValue: { id: 1, password_hash: 'leak' },
      }),
      true,
    );
    assert.deepEqual(e.changedFields, ['passwordHash']);
    assert.ok(!JSON.stringify(e).includes('leak'));
  });
});

describe('audit: toActivitySummary', () => {
  it('has exactly the keys of ActivitySummary', () => {
    const s = toActivitySummary(row());
    assert.deepEqual(Object.keys(s).sort(), [
      'action',
      'actor',
      'createdAt',
      'entityId',
      'entityLabel',
      'entityType',
      'eventName',
    ]);
  });
});
