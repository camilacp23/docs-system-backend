/**
 * The rules of the dependency audit gate (`scripts/auditGate.ts`): it blocks on high and critical advisories, accepts
 * only the listed advisory of the listed package, ignores lower severities and transitive entries, and reports stale and
 * overdue exceptions, and fails closed when there is no report. The real list holds the `effect` exception. Unit test over synthetic reports: it never runs `npm audit`.
 */
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import {
  collectAdvisories,
  evaluate,
  EXCEPTIONS,
  main,
  parseReport,
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

  it('the real list holds only the effect exception, and each entry must be well formed', () => {
    assert.deepEqual(
      EXCEPTIONS.map((e) => [e.package, e.id, e.reviewBy]),
      [['effect', 'GHSA-7589-6fvf-x4pw', '2026-12-31']],
    );
    for (const exception of EXCEPTIONS) {
      assert.match(exception.id, /^GHSA(-[a-z0-9]{4}){3}$/);
      assert.match(exception.reviewBy, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(exception.package.length > 0 && exception.reason.length > 40);
    }
  });

  it('the real exception covers the Prisma chain (prisma > @prisma/config > effect), and --strict does not', () => {
    const effect = advisory('effect', 'GHSA-7589-6fvf-x4pw', 'high', 'Effect ReDoS');
    const chain: AuditReport = {
      vulnerabilities: {
        effect: { via: [effect] },
        '@prisma/config': { via: ['effect'] },
        prisma: { via: ['@prisma/config'] },
      },
    };
    const verdict = evaluate(chain, EXCEPTIONS, '2026-11-19');
    assert.deepEqual(verdict.blocking, []);
    assert.deepEqual(
      verdict.accepted.map((a) => a.id),
      ['GHSA-7589-6fvf-x4pw'],
    );
    assert.deepEqual([verdict.stale, verdict.overdue], [[], []]);
    assert.equal(evaluate(chain, EXCEPTIONS, '2027-01-01').overdue.length, 1);
    assert.equal(evaluate(chain, [], '2026-11-19').blocking.length, 1);
    // Another advisory of the same package, or the same GHSA on another package, stays blocked.
    const other = reportOf(advisory('effect', 'GHSA-aaaa-bbbb-cccc', 'high'));
    assert.equal(evaluate(other, EXCEPTIONS, '2026-11-19').blocking.length, 1);
    const spoof = reportOf(advisory('left-pad', 'GHSA-7589-6fvf-x4pw', 'high'));
    assert.equal(evaluate(spoof, EXCEPTIONS, '2026-11-19').blocking.length, 1);
  });

  it('prints the review date of an accepted advisory', () => {
    const lines: string[] = [];
    mock.method(console, 'log', (line: string) => lines.push(line));
    mock.method(console, 'warn', () => undefined);
    try {
      assert.equal(
        main([], () => reportOf(PICOMATCH), [EXCEPTION], '2026-11-18'),
        0,
      );
    } finally {
      mock.restoreAll();
    }
    assert.ok(lines.some((l) => l.includes('no patched version reachable')));
    assert.ok(lines.some((l) => l.includes('review by 2027-01-31')));
  });

  it('with an empty list a high advisory blocks, and a report with nothing in it has nothing stale or overdue', () => {
    assert.equal(evaluate(reportOf(PICOMATCH), [], '2026-11-18').blocking.length, 1);
    const clean = evaluate({ vulnerabilities: {} }, [], '2026-11-18');
    assert.deepEqual([clean.blocking, clean.accepted, clean.stale, clean.overdue], [[], [], [], []]);
  });

  it('an exception that matches nothing in the report is stale and covers no other advisory', () => {
    const other = advisory('left-pad', 'GHSA-aaaa-bbbb-cccc', 'high');
    const verdict = evaluate(reportOf(other), [EXCEPTION], '2026-11-18');
    assert.deepEqual(verdict.stale, [EXCEPTION]);
    assert.deepEqual(verdict.accepted, []);
    assert.equal(verdict.blocking.length, 1);
  });

  describe('main (exit codes)', () => {
    const quiet = () => {
      mock.method(console, 'log', () => undefined);
      mock.method(console, 'warn', () => undefined);
      mock.method(console, 'error', () => undefined);
    };

    it('fails closed (2) when npm audit gave no usable report', () => {
      quiet();
      try {
        assert.equal(
          main([], () => null, [], '2026-11-18'),
          2,
        );
        // Even with an exception that would cover everything: no report, no pass.
        assert.equal(
          main([], () => null, [EXCEPTION], '2026-11-18'),
          2,
        );
      } finally {
        mock.restoreAll();
      }
    });

    it('passes (0) a clean report with an empty list, and fails (1) a high advisory nobody accepted', () => {
      quiet();
      try {
        assert.equal(
          main([], () => ({ vulnerabilities: {} }), [], '2026-11-18'),
          0,
        );
        assert.equal(
          main([], () => reportOf(PICOMATCH), [], '2026-11-18'),
          1,
        );
      } finally {
        mock.restoreAll();
      }
    });

    it('passes (0) an advisory with a valid exception, still passes an overdue one, and --strict ignores the list', () => {
      quiet();
      try {
        assert.equal(
          main([], () => reportOf(PICOMATCH), [EXCEPTION], '2026-11-18'),
          0,
        );
        assert.equal(
          main([], () => reportOf(PICOMATCH), [EXCEPTION], '2027-02-01'),
          0,
        );
        assert.equal(
          main(['--strict'], () => reportOf(PICOMATCH), [EXCEPTION], '2026-11-18'),
          1,
        );
      } finally {
        mock.restoreAll();
      }
    });
  });

  it('parseReport accepts a report and rejects an error entry, a missing list and text that is not JSON', () => {
    assert.deepEqual(parseReport('{"vulnerabilities":{}}'), { vulnerabilities: {} });
    assert.equal(parseReport('{"error":{"code":"ENOTFOUND"}}'), null);
    assert.equal(parseReport('{"metadata":{}}'), null);
    assert.equal(parseReport('<html>502</html>'), null);
    assert.equal(parseReport(''), null);
  });
});
