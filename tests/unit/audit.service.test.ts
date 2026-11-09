/**
 * Rules of the audit service (FR-21; D-107) with a repository that records what it is asked: the 400 rules, the order
 * of the 400 before the 403, DEVELOPER_OWN_ACTIONS, ids beyond `integer` and the shape of the recent activity.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiError } from '../../src/security/errors.js';
import type { AuditFilters, AuditRepository } from '../../src/modules/audit/repository.js';
import type { AuditRow } from '../../src/modules/audit/representation.js';
import { createAuditService } from '../../src/modules/audit/service.js';

const row = (over: Partial<AuditRow> = {}): AuditRow => ({
  id: 1n,
  action: 'UPDATE',
  eventName: null,
  entityType: 'screen',
  entityId: '1',
  entityLabel: 'x',
  applicationId: 1,
  actorId: 7,
  actorName: 'Seven',
  dbRole: 'docs_app',
  changedFields: ['known_issues'],
  oldValue: { known_issues: null },
  newValue: { known_issues: 'a' },
  createdAt: new Date('2026-11-01T00:00:00.000Z'),
  ...over,
});

/** A repository that records the filters it was asked for. */
function fake() {
  const calls: AuditFilters[] = [];
  const repository: AuditRepository = {
    readPage: (filters) => {
      calls.push(filters);
      return Promise.resolve({ rows: [row()], total: 1 });
    },
    readRecent: () => Promise.resolve([row()]),
  };
  return { calls, service: createAuditService(repository) };
}

const admin = { id: 1, role: 'ADMINISTRATOR' };
const dev = { id: 7, role: 'DEVELOPER' };
const page = { skip: 0, take: 20 };

const rejection = async (promise: Promise<unknown>): Promise<ApiError> => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ApiError);
    return error;
  }
  throw new assert.AssertionError({ message: 'expected a rejection' });
};

describe('audit service: rules that cross parameters (400)', () => {
  it('entityId without entityType: rule required on entityType', async () => {
    const { service, calls } = fake();
    const e = await rejection(service.list(admin, { ...page, entityId: '12' }));
    assert.equal(e.status, 400);
    assert.deepEqual(e.details, {
      fields: [{ field: 'entityType', rule: 'required', message: 'This value is required.' }],
    });
    assert.equal(calls.length, 0, 'PostgreSQL is not reached');
  });
  it('from later than to: rule range on to', async () => {
    const { service } = fake();
    const e = await rejection(
      service.list(admin, { ...page, from: '2026-11-02T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' }),
    );
    assert.equal(e.status, 400);
    assert.deepEqual(e.details, {
      fields: [{ field: 'to', rule: 'range', message: "'to' must not be earlier than 'from'." }],
    });
  });
  it('from equal to to is valid (both limits are inclusive)', async () => {
    const { service } = fake();
    const at = '2026-11-01T00:00:00.000Z';
    assert.equal((await service.list(admin, { ...page, from: at, to: at })).total, 1);
  });
  it('a text that Date.parse cannot read (leap second) skips the range rule and goes to PostgreSQL', async () => {
    const { service, calls } = fake();
    await service.list(admin, { ...page, from: '2026-12-31T23:59:60Z', to: '2026-01-01T00:00:00Z' });
    assert.equal(calls.length, 1);
  });
});

describe('audit service: DEVELOPER_OWN_ACTIONS', () => {
  it('without actorUserId the Developer sees their own actions', async () => {
    const { service, calls } = fake();
    await service.list(dev, page);
    assert.equal(calls[0]?.actorUserId, 7);
  });
  it('with their own id it is valid', async () => {
    const { service, calls } = fake();
    await service.list(dev, { ...page, actorUserId: 7 });
    assert.equal(calls[0]?.actorUserId, 7);
  });
  it('with another user it is 403 FORBIDDEN, OWN_ACTIONS, with the message of the role', async () => {
    const { service, calls } = fake();
    const e = await rejection(service.list(dev, { ...page, actorUserId: 8 }));
    assert.equal(e.status, 403);
    assert.equal(e.code, 'FORBIDDEN');
    assert.equal(e.message, "Your role doesn't allow this action.");
    assert.deepEqual(e.details, { reason: 'OWN_ACTIONS' });
    assert.equal(calls.length, 0);
  });
  it('an actorUserId beyond integer is also 403 for a Developer', async () => {
    const { service } = fake();
    const e = await rejection(service.list(dev, { ...page, actorUserId: 2_147_483_648 }));
    assert.deepEqual(e.details, { reason: 'OWN_ACTIONS' });
  });
  it('the 400 comes before the 403', async () => {
    const { service } = fake();
    const e = await rejection(service.list(dev, { ...page, actorUserId: 8, entityId: '3' }));
    assert.equal(e.status, 400);
    const r = await rejection(
      service.list(dev, {
        ...page,
        actorUserId: 8,
        from: '2026-11-02T00:00:00.000Z',
        to: '2026-11-01T00:00:00.000Z',
      }),
    );
    assert.equal(r.status, 400);
  });
  it('the Administrator may ask for any user, and the filter is not forced', async () => {
    const { service, calls } = fake();
    await service.list(admin, { ...page, actorUserId: 9 });
    await service.list(admin, page);
    assert.equal(calls[0]?.actorUserId, 9);
    assert.equal(calls[1]?.actorUserId, undefined);
  });
});

describe('audit service: ids beyond integer give an empty page', () => {
  it('applicationId and actorUserId, for the Administrator, without reaching the repository', async () => {
    const { service, calls } = fake();
    assert.deepEqual(await service.list(admin, { ...page, applicationId: 2_147_483_648 }), { data: [], total: 0 });
    assert.deepEqual(await service.list(admin, { ...page, actorUserId: 99_999_999_999 }), { data: [], total: 0 });
    assert.equal(calls.length, 0);
  });
  it('the largest integer still reaches the repository', async () => {
    const { service, calls } = fake();
    await service.list(admin, { ...page, applicationId: 2_147_483_647 });
    assert.equal(calls.length, 1);
  });
});

describe('audit service: dbRole by role', () => {
  it('only the Administrator receives it', async () => {
    const { service } = fake();
    assert.equal((await service.list(admin, page)).data[0]?.dbRole, 'docs_app');
    assert.equal('dbRole' in ((await service.list(dev, page)).data[0] ?? {}), false);
  });
});

describe('audit service: recent activity', () => {
  it('is a summary: no values and no database role', async () => {
    const { service } = fake();
    const [summary] = await service.recentActivity(1);
    assert.ok(summary);
    assert.deepEqual(Object.keys(summary).sort(), [
      'action',
      'actor',
      'createdAt',
      'entityId',
      'entityLabel',
      'entityType',
      'eventName',
    ]);
  });
  it('an application beyond integer has none', async () => {
    const { service } = fake();
    assert.deepEqual(await service.recentActivity(2_147_483_648), []);
  });
});
