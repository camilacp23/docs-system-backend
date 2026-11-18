/**
 * Authorization matrix against the real application (equivalent of A23): every protected operation of the contract
 * x 3 roles. A role listed in x-roles passes the gate (anything but 401/403); any other role gets 403 with
 * `requiredRoles`; with no token every operation is 401. Generated from the contract, so a new operation is covered
 * automatically.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { PUBLIC_OPERATIONS } from '../../src/http/operations.js';
import type { OperationPolicy, Role } from '../../src/security/rbac.js';
import { bearer, bodyOf, startTestApp, type TestApp } from '../helpers/app.js';

const ROLES: { role: Role; key: 'admin' | 'developer' | 'reader' }[] = [
  { role: 'ADMINISTRATOR', key: 'admin' },
  { role: 'DEVELOPER', key: 'developer' },
  { role: 'READER', key: 'reader' },
];

/** Concrete URL of an operation: path parameters replaced by values that satisfy the contract. */
const urlOf = (p: OperationPolicy): string =>
  p.expressPath.replace(':type', 'SCREEN').replace(':id', '999999').replace(':step', '1');

const send = (t: TestApp, p: OperationPolicy, token?: string) => {
  const req = t.http[p.method.toLowerCase() as 'get' | 'post' | 'put' | 'delete'](urlOf(p));
  return token === undefined ? req : req.set('Authorization', bearer(token));
};

describe('authorization matrix (real application)', () => {
  let t: TestApp;
  let protectedOps: OperationPolicy[];

  before(async () => {
    t = await startTestApp();
    protectedOps = [...t.built.policies.values()].filter((p) => !PUBLIC_OPERATIONS.has(p.operationId));
  });
  after(async () => {
    await t.close();
  });

  it('the contract has 53 operations, 4 public and 49 protected', () => {
    assert.equal(t.built.policies.size, 53);
    assert.equal(protectedOps.length, 49);
  });

  it('without a token every protected operation is 401', async () => {
    for (const p of protectedOps) {
      const res = await send(t, p);
      assert.equal(res.status, 401, p.operationId);
      assert.equal(bodyOf(res).code, 'UNAUTHENTICATED', p.operationId);
    }
  });

  it('49 operations x 3 roles: allowed roles pass the gate, the others get 403 with requiredRoles', async () => {
    let checked = 0;
    const unexpected: string[] = [];
    for (const p of protectedOps) {
      for (const { role, key } of ROLES) {
        const res = await send(t, p, t.users[key].token);
        const allowed = p.roles.includes(role);
        checked += 1;
        if (allowed) {
          // It may fail later (400 from the validator, 404 NOT_IMPLEMENTED) but never at the gate.
          if (res.status === 401 || res.status === 403) unexpected.push(`${p.operationId}/${role}: ${res.status}`);
        } else if (res.status !== 403 || bodyOf(res).code !== 'FORBIDDEN') {
          unexpected.push(`${p.operationId}/${role}: expected 403, got ${res.status}`);
        } else {
          assert.deepEqual(bodyOf(res).details, { requiredRoles: p.roles }, p.operationId);
          assert.equal(bodyOf(res).message, "Your role doesn't allow this action.");
        }
      }
    }
    assert.equal(checked, 147);
    assert.deepEqual(unexpected, []);
  });

  it('role changes in the database apply to the very next request (D-25)', async () => {
    await t.owner.query(`UPDATE app_user SET role = 'ADMINISTRATOR' WHERE id = $1`, [t.users.reader.id]);
    assert.notEqual((await t.http.get('/api/v1/users').set('Authorization', bearer(t.users.reader.token))).status, 403);
    await t.owner.query(`UPDATE app_user SET role = 'READER' WHERE id = $1`, [t.users.reader.id]);
    assert.equal((await t.http.get('/api/v1/users').set('Authorization', bearer(t.users.reader.token))).status, 403);
    await t.owner.query(`UPDATE app_user SET status = 'INACTIVE' WHERE id = $1`, [t.users.reader.id]);
    assert.equal((await t.http.get('/api/v1/users/1').set('Authorization', bearer(t.users.reader.token))).status, 401);
    await t.owner.query(`UPDATE app_user SET status = 'ACTIVE' WHERE id = $1`, [t.users.reader.id]);
  });
});
