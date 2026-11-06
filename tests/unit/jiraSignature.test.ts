/** Webhook signature (SDD Table 53, step 1): HMAC-SHA256 over the raw body, X-Hub-Signature `sha256=<hex>`. */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { verifyJiraSignature } from '../../src/integrations/jira/index.js';

const secret = 'webhook-secret-for-tests';
const payload = { webhookEvent: 'jira:issue_updated', issue: { id: '10003', key: 'TECHEA-3' } };
const body = Buffer.from(JSON.stringify(payload));
const sign = (raw: Buffer, key = secret): string => `sha256=${createHmac('sha256', key).update(raw).digest('hex')}`;

describe('verifyJiraSignature', () => {
  it('accepts the public HMAC-SHA256 test vector', () => {
    assert.equal(
      verifyJiraSignature(
        Buffer.from('Hello, World!'),
        'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
        "It's a Secret to Everybody",
      ),
      true,
    );
  });

  it('accepts a valid signature of the exact raw body', () => {
    assert.equal(verifyJiraSignature(body, sign(body), secret), true);
  });

  it('rejects a re-serialized body (the raw bytes are what is signed)', () => {
    const pretty = Buffer.from(JSON.stringify(payload, null, 2));
    assert.equal(verifyJiraSignature(pretty, sign(body), secret), false);
    assert.equal(verifyJiraSignature(Buffer.from(`${body.toString()} `), sign(body), secret), false);
  });

  it('rejects a wrong or unsupported prefix', () => {
    const hex = sign(body).slice('sha256='.length);
    for (const header of [
      `sha1=${hex}`,
      `sha512=${hex}`,
      `md5=${hex}`,
      hex,
      `sha256${hex}`,
      `=${hex}`,
      `sha256:${hex}`,
    ]) {
      assert.equal(verifyJiraSignature(body, header, secret), false, header.slice(0, 12));
    }
  });

  it('rejects signatures of a different length without throwing', () => {
    const hex = sign(body).slice('sha256='.length);
    for (const header of [
      'sha256=',
      `sha256=${hex.slice(0, 62)}`,
      `sha256=${hex.slice(0, 63)}`,
      `sha256=${hex}00`,
      `sha256=${hex}0`,
    ]) {
      assert.equal(verifyJiraSignature(body, header, secret), false, String(header.length));
    }
  });

  it('rejects non-hexadecimal text, a wrong secret, an empty secret and a missing header', () => {
    assert.equal(verifyJiraSignature(body, `sha256=${'z'.repeat(64)}`, secret), false);
    assert.equal(verifyJiraSignature(body, sign(body), 'other-secret'), false);
    assert.equal(verifyJiraSignature(body, sign(body, ''), ''), false);
    assert.equal(verifyJiraSignature(body, undefined, secret), false);
    assert.equal(verifyJiraSignature(body, '', secret), false);
  });

  it('rejects a tampered body', () => {
    assert.equal(
      verifyJiraSignature(Buffer.from(body.toString().replace('TECHEA-3', 'TECHEA-4')), sign(body), secret),
      false,
    );
  });
});
