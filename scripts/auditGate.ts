/**
 * `npm run audit:gate`: the blocking dependency audit of the CI (every dependency, development ones included).
 *
 * It fails on any advisory of severity `high` or `critical`, exactly like `npm audit --audit-level=high`, except for the
 * advisories listed in {@link EXCEPTIONS}. An exception exists only when NO patched version of the package has been
 * published, so no update can fix it; each one names the advisory, why it is accepted and when to review it. An
 * exception that no longer matches anything is reported as stale (remove it), and one past its review date is
 * reported as a warning, never silently kept. `--strict` ignores the exceptions (the plain audit).
 *
 * Fail closed: when `npm audit` gives no usable report (no network, registry error), the gate fails.
 *
 * @module scripts/auditGate
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** An advisory accepted on purpose. */
export type AuditException = {
  /** GHSA identifier of the advisory. */
  id: string;
  /** Package the advisory is about. */
  package: string;
  /** Why it is accepted. */
  reason: string;
  /** `YYYY-MM-DD`: after this day the gate warns until someone reviews the exception. */
  reviewBy: string;
};

/** An advisory found by `npm audit`. */
export type Advisory = { id: string; package: string; severity: string; title: string };

/** The part of `npm audit --json` that the gate reads. */
export type AuditReport = {
  error?: unknown;
  vulnerabilities?: Record<
    string,
    { via: (string | { name: string; severity: string; title: string; url: string })[] }
  >;
};

/** The accepted advisories. Keep this list as short as possible. */
export const EXCEPTIONS: readonly AuditException[] = [
  {
    id: 'GHSA-fc5q-39xc-vjpf',
    package: 'picomatch',
    reason:
      'ReDoS through repeated extglobs. Every published version (up to 4.0.7, the latest) is affected, so there is no ' +
      'patched release to install. It is reached only by development tools (lint-staged, typescript-eslint, the ' +
      'Bruno CLI) that match file names of this repository, never by the API at runtime or by user input.',
    reviewBy: '2027-01-31',
  },
];

const BLOCKING = new Set(['high', 'critical']);

/**
 * The distinct advisories of a report (one per GHSA), from the `via` entries that are advisories and not packages.
 *
 * @param report - Parsed `npm audit --json`.
 */
export function collectAdvisories(report: AuditReport): Advisory[] {
  const found = new Map<string, Advisory>();
  for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vulnerability.via) {
      if (typeof via === 'string') continue;
      const id = via.url.split('/').pop() ?? via.url;
      if (!found.has(id)) found.set(id, { id, package: via.name, severity: via.severity, title: via.title });
    }
  }
  return [...found.values()];
}

/** The verdict of the gate. */
export type Verdict = {
  /** High or critical advisories nobody accepted: the gate fails when there is one. */
  blocking: Advisory[];
  /** High or critical advisories covered by an exception. */
  accepted: Advisory[];
  /** Exceptions that match no advisory of the report: remove them. */
  stale: AuditException[];
  /** Exceptions in use whose review date has passed. */
  overdue: AuditException[];
};

/**
 * Applies the exceptions to a report.
 *
 * @param report - Parsed `npm audit --json`.
 * @param exceptions - The accepted advisories.
 * @param today - `YYYY-MM-DD`, to find the overdue exceptions.
 */
export function evaluate(report: AuditReport, exceptions: readonly AuditException[], today: string): Verdict {
  const advisories = collectAdvisories(report);
  const severe = advisories.filter((a) => BLOCKING.has(a.severity));
  const covered = (a: Advisory): boolean => exceptions.some((e) => e.id === a.id && e.package === a.package);
  const blocking = severe.filter((a) => !covered(a));
  const accepted = severe.filter(covered);
  const stale = exceptions.filter((e) => !severe.some((a) => a.id === e.id && a.package === e.package));
  const overdue = exceptions.filter((e) => !stale.includes(e) && e.reviewBy < today);
  return { blocking, accepted, stale, overdue };
}

/** Runs `npm audit --json` and parses it; `null` when the output is not a report. */
function runAudit(): AuditReport | null {
  // `npm audit` exits 1 when it finds anything, so the exit code is not read: the report is.
  const result = spawnSync('npm', ['audit', '--json'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
  });
  try {
    const report = JSON.parse(result.stdout) as AuditReport;
    return report.error === undefined && report.vulnerabilities !== undefined ? report : null;
  } catch {
    return null;
  }
}

const describe = (a: Advisory): string => `  - ${a.package} (${a.severity}): ${a.title} [${a.id}]`;

/** Entry point of `npm run audit:gate`; returns the exit code. */
function main(args: readonly string[]): number {
  const report = runAudit();
  if (report === null) {
    console.error('audit gate: npm audit gave no usable report (registry or network error); failing closed.');
    return 2;
  }
  const strict = args.includes('--strict');
  const verdict = evaluate(report, strict ? [] : EXCEPTIONS, new Date().toISOString().slice(0, 10));
  if (verdict.accepted.length > 0) {
    console.log('Accepted advisories (no patched version exists; see EXCEPTIONS in scripts/auditGate.ts):');
    for (const a of verdict.accepted) console.log(describe(a));
  }
  for (const e of verdict.overdue)
    console.warn(`WARNING: the exception for ${e.id} is past its review date ${e.reviewBy}.`);
  for (const e of verdict.stale) console.warn(`NOTE: the exception for ${e.id} matches nothing now; remove it.`);
  if (verdict.blocking.length > 0) {
    console.error('Blocking advisories (high or critical):');
    for (const a of verdict.blocking) console.error(describe(a));
    return 1;
  }
  console.log('audit gate: no blocking advisory.');
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
