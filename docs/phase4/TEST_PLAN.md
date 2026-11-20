# Test plan: functional verification of "Documentación técnica"

Phase 4. This plan defines what is verified, with which tools, in which environments and with which criteria. The results
are in [TRACEABILITY_MATRIX.md](TRACEABILITY_MATRIX.md), the manual cases in [MANUAL_CASES.md](MANUAL_CASES.md) and the
defects in [DEFECTS.md](DEFECTS.md).

## 1. Objective

Verify that the system meets the functional requirements FR-01 to FR-27 and the non-functional requirements NFR-01 to
NFR-20 of the SRS v1.3, with the changes approved after it (SDD v1.4 and the decisions of
`docs/phase3/DECISIONS_FASE3.md`, including the API contract 0.5.1), and leave the evidence traceable: each requirement
is linked to the test cases that verify it and to a result (Pass, Partial or Not run).

## 2. Scope and exclusions

In scope: the 53 operations of the OpenAPI contract 0.5.1, the database rules (triggers, constraints, privileges and
audit), the web interface of the eleven modules, the integration with Jira Cloud (project TECHEA) and the deployment on
Render with its backup.

| Exclusion | Reason |
| --------- | ------ |
| FR-26: content of SAR | Only the seeding mechanism is verified. The technical documentation of SAR was not loaded into the system, so no case verifies its content (FR-26 is Partial). |
| Load of 30 concurrent users (NFR-10) | Not run. Response times were measured on disposable databases only (NFR-10 is Partial). |
| Availability measurement (NFR-13) | Not run. There is no measurement of the 99% of business hours (NFR-13 is Partial). |
| Several API instances | The API assumes one process (D-155); behavior with several instances is not tested. |
| Native mobile application | Not required by NFR-19. |

## 3. Levels and tools

| Level | Tool | What it verifies | Where it runs |
| ----- | ---- | ---------------- | ------------- |
| Backend automatic | `node:test` with `tsx` (`npm test`, files in `tests/unit/` and `tests/integration/`) | Services, routes, authorization, errors, ETags, concurrency, audit, Jira client and webhook against a simulator, reports, search, dashboard | Backend repository, disposable databases (never `docs_system`) |
| Backend performance | `node:test` (`npm run test:perf`, files in `tests/perf/`) | Timings on a department-scale data set. It does not assert time limits and is not part of `npm test` | Backend repository, disposable database |
| Legacy (Phase 2) | `npm run test:legacy` (tests `01_` to `10_` in `tests/`) | 153 checks of the verified design: model integrity, audit privileges, signature, workflow, authentication and RBAC, request validation, dependency graph | Backend repository, disposable copies of a database built from the migrations |
| Bruno collection | Bruno CLI (`npm run test:api`, `bruno/docs-system-api/`) against the API and the Jira simulator | Every implemented operation by module and role | Local sandbox database `docs_sandbox` |
| Frontend automatic | Vitest and Testing Library (`npm test` in the frontend repository, `src/test/`) | Pages, forms, states by role, ETag handling, session, dependency map, reports | Frontend repository |
| Manual in the browser | Browser against the sandbox and against production | Flows across the interface and the API with real roles | See section 4 |
| Manual against Jira Cloud | Production API connected to the project TECHEA | Ticket creation, webhook, synchronization | Production |
| Static checks | `npm run lint`, `typecheck`, `format:check`, `audit:gate`, `db:drift` and the contract checks | Standards (NFR-17), contract and database consistency | Backend repository |

Test case IDs: `BE-Unn`, `BE-Inn` and `BE-Pnn` (one per backend unit, integration and performance file), `LG-nn`
(Phase 2 test file), `BR-<folder>` (Bruno folder), `FE-<area>` (folder of `src/test` in the frontend), `MS-nn`
(manual, sandbox), `MP-nn` (manual, production), `MJ-nn` (manual, Jira Cloud) and `MB-nn` (manual, backup). Automatic
cases are identified by file or folder, not by individual test; the catalog is in the appendix of the traceability matrix.

## 4. Environments

| Environment | Composition | Use |
| ----------- | ----------- | --- |
| Sandbox (local) | PostgreSQL 18 database `docs_sandbox` filled by `npm run sandbox:db`, API on port 3001, local Jira simulator, frontend with the Vite proxy | Bruno collection and manual cases `MS-nn` |
| Disposable databases (local) | Copies of `docs_test_template`, created and dropped by the tests | Backend automatic, performance and legacy tests |
| Production (Render) | API as a Web Service (Starter plan, one instance), Render Postgres 18 and the frontend as a Static Site with the rewrite `/api/*` to the API, so that the browser, the frontend and the API share one origin and the cookie `rt` keeps `SameSite=Strict` (D-155) | Manual cases `MP-nn`, `MJ-nn` and `MB-nn` |
| Jira Cloud | Project TECHEA, reached from production | Manual cases `MJ-nn` |

The migrations and the seed are applied to production from the operator's computer (see `OPERATIONS_NOTES.md`).

## 5. Roles tested

| Role | What is verified |
| ---- | ---------------- |
| Administrator | Everything: users, applications, documentation, review decisions, reports, audit of all users |
| Developer | Create and edit documentation, comment, submit to review; no administration menu; review queue is read-only; audit of their own actions only |
| Reader | Read-only access; only published reports; comments allowed; no access to the audit page |

The authorization matrix is generated from `x-roles` of the contract and checked for every operation and role by the
backend tests and by the legacy test 07.

## 6. Entry criteria

- The branch under test is merged in `develop` of both repositories and the API contract of the frontend is synchronized with
  the one of the backend (0.5.1).
- Lint, typecheck and format checks pass.
- The database migrations are applied (8 migrations) and `npm run db:drift` reports no difference.
- For manual cases: the environment is deployed, the three roles exist and the seed was applied.
- Tests never run against `docs_system`.

## 7. Exit criteria

- Every requirement has a result in the traceability matrix. A requirement is Pass only when all its automatic cases pass and
  its manual cases (if any) pass; Partial when part of the requirement is not verified (the matrix says which part and why);
  Not run when no case was run.
- No defect of severity critical or high is open. Medium and low defects may stay open if they are recorded with a decision
  (accepted until a date, or planned).
- The automatic suites finish with 0 failures: backend `npm test`, `npm run test:legacy` (153 checks), the Bruno collection and
  the frontend tests.
- Every Partial and Not run result has its reason in the matrix.

## 8. Defect severity

| Severity | Definition |
| -------- | ---------- |
| Critical | Data loss or corruption, a security failure (access without authorization, exposed secret) or the system cannot be used. No workaround. |
| High | A requirement does not work or shows wrong data to the user, or a deployment cannot proceed. A workaround exists but is not reasonable. |
| Medium | A function works but with a visible failure, a wrong message or a broken check that does not affect the data. A reasonable workaround exists. |
| Low | Cosmetic, documentation or process issue with no effect on the behavior of the system. |

## 9. How a defect is recorded and closed

1. **Record.** Add a row to [DEFECTS.md](DEFECTS.md) with an ID (`DEF-nn`), the detection date, the module, the severity, the
   description, the steps to reproduce and the cause when known. The status is Open.
2. **Fix.** The fix is a commit (or a pull request) on a branch, with a Conventional Commit message. A change of behavior
   needs a decision in `DECISIONS_FASE3.md` when the design is affected.
3. **Regression test.** The fix includes a test that fails without it and passes with it. When a test is not possible (a
   documentation or process defect), the row says so and gives the check that replaces it.
4. **Close.** The row records the commit or pull request, verified in `git log`, the regression test and the status Fixed.
5. **Accept.** A defect that is not fixed is recorded as Accepted with the approval, the reason and a review date, and it is
   reviewed on that date (for example D-156).

Incidents found while deploying are recorded in their own section of DEFECTS.md as lessons for the procedure, with the
symptom, the cause, the correction and how to avoid them.
