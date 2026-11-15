/**
 * `actAs` against a real database: a write made in a transaction that called it is recorded in `audit_log` with that
 * user as the actor, and the setting does not leak to the next transaction of the pool (it is transaction-local).
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { createApplication } from '../helpers/applications.js';
import { actAs } from '../../src/db/prisma.js';

describe('actAs: audit attribution', () => {
  let t: TestApp;
  let applicationId: number;

  before(async () => {
    t = await startTestApp();
    try {
      applicationId = (await createApplication(t, t.users.admin.token)).application.id;
    } catch (error) {
      await t.close();
      throw error;
    }
  });
  after(() => t.close());

  const lastActor = async (marker: string): Promise<number | null> => {
    const { rows } = await t.owner.query<{ actor_user_id: number | null }>(
      `SELECT actor_user_id FROM audit_log WHERE entity_type = 'application' AND entity_id = $1 AND new_value->>'description' = $2
        ORDER BY id DESC LIMIT 1`,
      [String(applicationId), marker],
    );
    assert.equal(rows.length, 1, marker);
    return rows[0]!.actor_user_id;
  };

  it('attributes the write of the transaction to the given user, and the next transaction has no actor', async () => {
    await t.db.base.$transaction(async (tx) => {
      await actAs(tx, t.users.developer.id);
      await tx.application.update({ where: { id: applicationId }, data: { description: 'written as the developer' } });
    });
    assert.equal(await lastActor('written as the developer'), t.users.developer.id);

    await t.db.base.application.update({
      where: { id: applicationId },
      data: { description: 'written with no actor' },
    });
    assert.equal(await lastActor('written with no actor'), null);
  });
});
