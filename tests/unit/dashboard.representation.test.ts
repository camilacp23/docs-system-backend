/**
 * The response of the dashboard built from the counts (FR-19; D-106; READER_OVERVIEW). Pure, no database.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toIndicators, type IndicatorRow } from '../../src/modules/dashboard/representation.js';

const ROW: IndicatorRow = {
  byStatus: { UNDOCUMENTED: 3, DRAFT: 2, IN_PROGRESS: 2, IN_REVIEW: 1, APPROVED: 4 },
  variablesTotal: 40,
  variablesUntraced: 5,
  collectionsTotal: 9,
  collectionsUndocumented: 2,
  pendingSubtasks: 6,
  lastSyncedAt: new Date('2026-11-08T15:04:05.123Z'),
};
const ACTIVITY = [{ action: 'CREATE', entityType: 'variable' }];

describe('dashboard: the response by role', () => {
  it('with recent activity (Administrator, Developer): the key is there', () => {
    const data = toIndicators(ROW, true, ACTIVITY);
    assert.deepEqual(data.recentActivity, ACTIVITY);
  });

  it('with an empty activity: the key is an empty array (the team has done nothing)', () => {
    assert.deepEqual(toIndicators(ROW, true, []).recentActivity, []);
  });

  it('without activity (Reader): the key does not exist, it is not null or empty', () => {
    const data = toIndicators(ROW, true, undefined);
    assert.ok(!('recentActivity' in data));
    assert.equal(Object.keys(data).includes('recentActivity'), false);
    assert.ok(!JSON.stringify(data).includes('recentActivity'));
  });

  it('the figures are the same for every role', () => {
    const { recentActivity: _unused, ...withActivity } = toIndicators(ROW, true, ACTIVITY);
    assert.deepEqual(withActivity, toIndicators(ROW, true, undefined));
  });

  it('documentation: the total is the sum of the five statuses and the percent is of that total', () => {
    const { documentation } = toIndicators(ROW, false);
    assert.equal(documentation.totalScreens, 12);
    assert.deepEqual(documentation.byStatus, ROW.byStatus);
    assert.equal(documentation.approvedPercent, 33.3);
  });

  it('every status is present even when it is 0', () => {
    const row = { ...ROW, byStatus: { UNDOCUMENTED: 1, DRAFT: 0, IN_PROGRESS: 0, IN_REVIEW: 0, APPROVED: 0 } };
    const { documentation } = toIndicators(row, false);
    assert.deepEqual(Object.keys(documentation.byStatus), [
      'UNDOCUMENTED',
      'DRAFT',
      'IN_PROGRESS',
      'IN_REVIEW',
      'APPROVED',
    ]);
    assert.equal(documentation.totalScreens, 1);
    assert.equal(documentation.approvedPercent, 0);
  });

  it('jira: availability as given and the time as an ISO instant, or null', () => {
    assert.deepEqual(toIndicators(ROW, false).jira, {
      pendingSubtasks: 6,
      jiraAvailable: false,
      lastSyncedAt: '2026-11-08T15:04:05.123Z',
    });
    assert.equal(toIndicators({ ...ROW, lastSyncedAt: null }, true).jira.lastSyncedAt, null);
  });

  it('variables and collections', () => {
    const data = toIndicators(ROW, true);
    assert.deepEqual(data.variables, { total: 40, untraced: 5 });
    assert.deepEqual(data.collections, { total: 9, undocumented: 2 });
  });
});
