/**
 * The real registry of modules (`createModuleHandlers`) covers every operation of the contract: since Module 11 no
 * operation is left without a handler. The NOT_IMPLEMENTED mechanism stays as a safeguard for an operation added to the
 * contract before its module (it is tested with an application of its own in `app.chain.test.ts`); this test fails
 * when such an operation is added without a handler, so the gap is seen at once and not in production.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startTestApp, type TestApp } from '../helpers/app.js';

describe('the real module registry', () => {
  let t: TestApp;
  before(async () => {
    t = await startTestApp(); // no handlers given: the application builds the real registry
  });
  after(async () => {
    await t.close();
  });

  it('covers the 53 operations of the contract: none is left to answer NOT_IMPLEMENTED', () => {
    assert.equal(t.built.policies.size, 53);
    assert.deepEqual(t.built.notImplemented, []);
  });

  it('answers a real 404 for an unknown application, not NOT_IMPLEMENTED, on the last operation that was missing', async () => {
    const res = await t.http
      .get('/api/v1/onboarding/summary?applicationId=999999')
      .set('Authorization', `Bearer ${t.users.admin.token}`);
    assert.equal(res.status, 404);
    const body = res.body as { code: string; details: { reason?: string; resource?: string } };
    assert.equal(body.code, 'NOT_FOUND');
    assert.notEqual(body.details.reason, 'NOT_IMPLEMENTED');
  });
});
