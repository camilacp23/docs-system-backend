/** Summary of the screen's Epic (D-91): `<screen> (<application>)`, cut on the screen name when it is too long. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { epicSummary } from '../../src/modules/screens/jiraTickets.js';

describe('epicSummary', () => {
  it('is "<screen> (<application>)"', () => {
    assert.equal(epicSummary('Login', 'SAR'), 'Login (SAR)');
  });

  it('keeps a summary of exactly 255 characters', () => {
    const name = 'n'.repeat(255 - ' (SAR)'.length);
    const summary = epicSummary(name, 'SAR');
    assert.equal(summary.length, 255);
    assert.equal(summary, `${name} (SAR)`);
  });

  it('cuts the screen name with "…" and keeps " (<application>)" complete when it is over 255', () => {
    const application = 'A'.repeat(120);
    const summary = epicSummary('s'.repeat(150), application);
    assert.ok(summary.length <= 255);
    assert.ok(summary.endsWith(` (${application})`));
    assert.match(summary, /^s+…/);
    assert.equal(summary, `${'s'.repeat(255 - ` (${application})`.length - 1)}…${` (${application})`}`);
  });

  it('turns line breaks and runs of spaces into one space (a summary is one line)', () => {
    assert.equal(epicSummary('Log\nin  page', 'SAR\r\nApp'), 'Log in page (SAR App)');
  });

  it('never splits a surrogate pair when it cuts', () => {
    const summary = epicSummary('😀'.repeat(150), 'A'.repeat(100));
    assert.ok(summary.length <= 255);
    assert.doesNotMatch(summary, /[\ud800-\udbff](?![\udc00-\udfff])/);
    assert.doesNotMatch(summary, /(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });
});
