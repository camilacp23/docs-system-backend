/**
 * The rules of the dependency audit gate (`scripts/auditGate.ts`): it blocks on high and critical advisories, accepts
 * only the listed advisory of the listed package, ignores lower severities and transitive entries, and reports stale and
 * overdue exceptions. Unit test over synthetic reports: it never runs `npm audit`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  collectAdvisories,
  evaluate,
  EXCEPTIONS,
  type AuditException,
  type AuditReport,
} from '../../scripts/auditGate.js';

const advisory = (name: string, id: string, severity: string, title = `${name} problem`) => ({
  name,
  severity,
  title,
  url: `https://github.com/advisories/${id}`,
});

/** A report where `npm audit` lists the given advisories under their own package, and dependents by name. */
const reportOf = (...items: ReturnType<typeof advisory>[]): AuditReport => ({
  vulnerabilities: {
    ...Object.fromEntries(items.map((item) => [item.name, { via: [item] }])),
    dependent: { via: items.map((item) => item.name) },
  },
});

const PICOMATCH = advisory('picomatch', 'GHSA-fc5q-39xc-vjpf', 'high');
const EXCEPTION: AuditException = {
  id: PICOMATCH.url.split('/').pop()!,
  package: 'picomatch',
  reason: 'r',
  reviewBy: '2027-01-31',
};

describe('audit gate', () => {
  it('collects each advisory once, from the entries that are advisories and not package names', () => {
    const report: AuditReport = {
      vulnerabilities: {
        picomatch: { via: [PICOMATCH] },
        fdir: { via: ['picomatch', PICOMATCH] },
        tinyglobby: { via: ['fdir'] },
      },
    };
    assert.deepEqual(collectAdvisories(report), [
      { id: 'GHSA-fc5q-39xc-vjpf', package: 'picomatch', severity: 'high', title: 'picomatch problem' },
    ]);
  });

  it('blocks a high advisory that nobody accepted', () => {
    const verdict = evaluate(reportOf(PICOMATCH), [], '2026-11-18');
    assert.deepEqual(
      verdict.blocking.map((a) => a.id),
      ['GHSA-fc5q-39xc-vjpf'],
    );
    assert.deepEqual(verdict.accepted, []);
  });

  it('accepts the listed advisory of the listed package and nothing else', () => {
    const other = advisory('left-pad', 'GHSA-aaaa-bbbb-cccc', 'high');
    const verdict = evaluate(reportOf(PICOMATCH, other), [EXCEPTION], '2026-11-18');
    assert.deepEqual(
      verdict.accepted.map((a) => a.package),
      ['picomatch'],
    );
    assert.deepEqual(
      verdict.blocking.map((a) => a.package),
      ['left-pad'],
    );
  });

  it('does not accept the same GHSA when it is reported for another package', () => {
    const spoof = advisory('another-package', EXCEPTION.id, 'high');
    assert.deepEqual(evaluate(reportOf(spoof), [EXCEPTION], '2026-11-18').blocking.length, 1);
  });

  it('blocks a critical advisory, and ignores moderate and low ones', () => {
    assert.equal(
      evaluate(reportOf(advisory('a', 'GHSA-1111-1111-1111', 'critical')), [], '2026-11-18').blocking.length,
      1,
    );
    const mild = reportOf(
      advisory('b', 'GHSA-2222-2222-2222', 'moderate'),
      advisory('c', 'GHSA-3333-3333-3333', 'low'),
    );
    assert.deepEqual(evaluate(mild, [], '2026-11-18').blocking, []);
  });

  it('passes a report with nothing in it', () => {
    assert.deepEqual(evaluate({ vulnerabilities: {} }, [EXCEPTION], '2026-11-18').blocking, []);
  });

  it('reports an exception that matches nothing as stale, and one past its review date as overdue', () => {
    assert.deepEqual(evaluate({ vulnerabilities: {} }, [EXCEPTION], '2026-11-18').stale, [EXCEPTION]);
    assert.deepEqual(evaluate(reportOf(PICOMATCH), [EXCEPTION], '2027-02-01').overdue, [EXCEPTION]);
    assert.deepEqual(evaluate(reportOf(PICOMATCH), [EXCEPTION], '2027-01-31').overdue, []);
    assert.deepEqual(evaluate(reportOf(PICOMATCH), [EXCEPTION], '2026-11-18').stale, []);
  });

  it('the real exceptions are well formed: a GHSA id, a reason and a review date', () => {
    assert.ok(EXCEPTIONS.length > 0);
    for (const exception of EXCEPTIONS) {
      assert.match(exception.id, /^GHSA(-[a-z0-9]{4}){3}$/);
      assert.match(exception.reviewBy, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(exception.package.length > 0 && exception.reason.length > 40);
    }
  });
});
