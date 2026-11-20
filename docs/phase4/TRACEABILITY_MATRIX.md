# Traceability matrix: requirements to test cases

Phase 4. One row per requirement of the SRS v1.3 (FR-01 to FR-27 and NFR-01 to NFR-20). The plan is in
[TEST_PLAN.md](TEST_PLAN.md), the manual cases in [MANUAL_CASES.md](MANUAL_CASES.md) and the defects in
[DEFECTS.md](DEFECTS.md). The design-level matrix (requirements to tables, endpoints and screens) is Table 72 of the SDD v1.4;
this one links requirements to tests.

State verified: backend `develop` at `dc7a47f` (API contract 0.5.1, 53 operations, 8 migrations); frontend `develop` at `81bbcdb`.

## 1. Totals

| Suite | Count | Result | Source |
| ----- | ----- | ------ | ------ |
| Backend `npm test` (unit and integration) | 129 files (43 unit, 86 integration); 1583 tests in 400 suites | 1583 pass, 0 fail, 0 skipped | Run on 2026-11-20 on this branch, once, without sandbox: `~/evidence/B-35/npm-test.txt` (exit code in `exit-codes.txt`) |
| Backend performance (`npm run test:perf`) | 3 files | Not part of `npm test`; not run for this matrix | Files in `tests/perf/` |
| Legacy, Phase 2 (`npm run test:legacy`) | 153 checks (tests 01 to 09) and the table of test 10 | 153 pass, table equal | Not run again: last run in `~/evidence/B-33/test-legacy.txt` (exit 0). The split per test is Table 74 of the SDD |
| Bruno (`npm run test:api`) | 16 folders; 998 requests executed (the polling requests of `Reports` repeat) | 998 passed; 2327 of 2327 tests | Not run again: last complete run, `~/evidence/B-34/test-api-2.txt`; the same figures are in `bruno/docs-system-api/README.md`. The run of `~/evidence/B-33` stopped because port 3001 was busy |
| Frontend (Vitest) | 153 test files, 2270 tests | 2270 pass | Not run again: last run of the branch that measured it, `~/evidence/F-23/vitest-3.txt`. The 153 files were counted statically on the current frontend `develop` and match |

The 129 backend files are the ones that `npm test` runs; the 3 files of `tests/perf` and the 10 legacy files are outside that
count. Counts of files per catalog are in the appendix.

| Result | Requirements |
| ------ | ------------ |
| Pass | 39 |
| Partial | 8 |
| Not run | 0 |

## 2. Partial results and why

| Requirement | Reason |
| ----------- | ------ |
| FR-26 | The seeding mechanism is verified; the content of SAR was not loaded. |
| NFR-04 | Outbound HTTPS and HSTS are tested; the HTTPS of the browser path in production is not recorded by any case. |
| NFR-07 | No dedicated check of visual consistency (indirect evidence only). |
| NFR-09 | The vocabulary is verified; the learning curve was not measured. |
| NFR-10 | Measurements on disposable databases; no load of 30 concurrent users and no measurement in production. |
| NFR-13 | No availability measurement; only the always-on plan and the backup verification exist. |
| NFR-15 | Structure only; no automated check of the module boundaries. |
| NFR-19 | No case in this phase verifies the layout below 1440 px. |

NFR-18 is Pass: Google Chrome (MP-01 to MP-06) and Microsoft Edge (MP-07, 2026-11-20).

## 3. Matrix

How the automatic cases were chosen: the backend files are linked by the requirement IDs written in the file itself, plus the
files that verify a requirement by scope (listed in the appendix notes); the legacy tests, the Bruno folders and the frontend
folders are linked by their scope. Types: backend auto, legacy, Bruno, frontend auto, manual sandbox, manual production, manual
Jira (manual backup cases MB-nn are listed as manual production).

| Requirement | Test cases | Type | Evidence | Result | Notes |
|---|---|---|---|---|---|
| FR-01 | BE-I15, LG-07, BR-Auth, FE-AUTH, FE-SESSION, MP-03, MP-04 | backend auto, legacy, Bruno, frontend auto, manual production | `tests/integration/auth.login.test.ts`<br>`tests/07_auth_rbac.test.ts`<br>Bruno folders `Auth`<br>frontend `src/test/{auth,session}`<br>MANUAL_CASES.md | Pass |  |
| FR-02 | BE-I81, BE-I82, BR-Users, FE-USERS, MP-04, MP-05 | backend auto, Bruno, frontend auto, manual production | `tests/integration/{users.read,users.write}.test.ts`<br>Bruno folders `Users`<br>frontend `src/test/{users}`<br>MANUAL_CASES.md | Pass |  |
| FR-03 | BE-I80, BE-I82, LG-07, BR-Users, FE-USERS, MP-05, MP-06 | backend auto, legacy, Bruno, frontend auto, manual production | `tests/integration/{users.concurrency,users.write}.test.ts`<br>`tests/07_auth_rbac.test.ts`<br>Bruno folders `Users`<br>frontend `src/test/{users}`<br>MANUAL_CASES.md | Pass |  |
| FR-04 | BE-I81, LG-07, BR-Users, FE-LAYOUT, FE-USERS, MP-05, MP-06 | backend auto, legacy, Bruno, frontend auto, manual production | `tests/integration/users.read.test.ts`<br>`tests/07_auth_rbac.test.ts`<br>Bruno folders `Users`<br>frontend `src/test/{layout,users}`<br>MANUAL_CASES.md | Pass |  |
| FR-05 | BE-I47, BE-I58, BE-I84, BE-I85, BE-I86, LG-01, BR-Variables, BR-LinkedItems, FE-VARIABLES, MS-01, MP-04 | backend auto, legacy, Bruno, frontend auto, manual sandbox, manual production | `tests/integration/{readModels.golden,screens.etag.linked,variables.originUsedIn,variables.read,variables.write}.test.ts`<br>`tests/01_integrity_tests.sql`<br>Bruno folders `Variables`, `LinkedItems`<br>frontend `src/test/{variables}`<br>MANUAL_CASES.md | Pass |  |
| FR-06 | BE-I85, BE-I86, BR-Variables, BR-LinkedItems, FE-VARIABLES, MP-04 | backend auto, Bruno, frontend auto, manual production | `tests/integration/{variables.read,variables.write}.test.ts`<br>Bruno folders `Variables`, `LinkedItems`<br>frontend `src/test/{variables}`<br>MANUAL_CASES.md | Pass |  |
| FR-07 | BE-I85, BE-I86, LG-01, BR-Variables, FE-VARIABLES, MP-04 | backend auto, legacy, Bruno, frontend auto, manual production | `tests/integration/{variables.read,variables.write}.test.ts`<br>`tests/01_integrity_tests.sql`<br>Bruno folders `Variables`<br>frontend `src/test/{variables}`<br>MANUAL_CASES.md | Pass |  |
| FR-08 | BE-I19, BE-I20, BE-I21, BE-I22, BE-I47, BR-Collections, FE-COLLECTIONS, MP-04 | backend auto, Bruno, frontend auto, manual production | `tests/integration/{collections.delete,collections.read,collections.update,collections.write,readModels.golden}.test.ts`<br>Bruno folders `Collections`<br>frontend `src/test/{collections}`<br>MANUAL_CASES.md | Pass |  |
| FR-09 | BE-I20, BE-I21, BE-I22, BE-I47, BR-Collections, FE-COLLECTIONS, MP-04 | backend auto, Bruno, frontend auto, manual production | `tests/integration/{collections.read,collections.update,collections.write,readModels.golden}.test.ts`<br>Bruno folders `Collections`<br>frontend `src/test/{collections}`<br>MANUAL_CASES.md | Pass |  |
| FR-10 | BE-I56, BE-I57, BE-I58, BE-I59, BE-I65, BE-I66, BE-I69, BE-I71, BR-Screens, BR-LinkedItems, FE-SCREENS, MP-04, MS-01 | backend auto, Bruno, frontend auto, manual production, manual sandbox | `tests/integration/{screens.contract,screens.delete,screens.etag.linked,screens.etag,screens.list,screens.read,screens.update,screens.write}.test.ts`<br>Bruno folders `Screens`, `LinkedItems`<br>frontend `src/test/{screens}`<br>MANUAL_CASES.md | Pass |  |
| FR-11 | BE-I56, BE-I69, BE-I71, BR-Screens, BR-LinkedItems, FE-SCREENS, MP-04, MS-01 | backend auto, Bruno, frontend auto, manual production, manual sandbox | `tests/integration/{screens.contract,screens.update,screens.write}.test.ts`<br>Bruno folders `Screens`, `LinkedItems`<br>frontend `src/test/{screens}`<br>MANUAL_CASES.md | Pass |  |
| FR-12 | BE-I41, BE-I60, BE-I61, BE-I63, BE-I64, BE-U23, LG-01, LG-05, BR-Jira, FE-SCREENS, MJ-01, MJ-02, MJ-03, MJ-04, MJ-05, MJ-06 | backend auto, legacy, Bruno, frontend auto, manual Jira | `tests/integration/{jira.webhook,screens.jiraTicket.concurrency,screens.jiraTicket,screens.jiraTicket.unsaved,screens.jiraTree}.test.ts`; `tests/unit/jiraView.test.ts`<br>`tests/01_integrity_tests.sql`; `tests/05_jira_signature.test.ts`<br>Bruno folders `Jira`<br>frontend `src/test/{screens}`<br>MANUAL_CASES.md | Pass | Verified against the local Jira simulator (backend and Bruno) and manually against Jira Cloud TECHEA from production. |
| FR-13 | BE-I71, BR-Screens, FE-SCREENS | backend auto, Bruno, frontend auto | `tests/integration/screens.write.test.ts`<br>Bruno folders `Screens`<br>frontend `src/test/{screens}` | Pass | No manual case. |
| FR-14 | BE-I65, BE-I66, BE-I68, BE-I69, BE-I70, BE-U13, LG-06, BR-Screens, FE-SCREENS, MP-04 | backend auto, legacy, Bruno, frontend auto, manual production | `tests/integration/{screens.list,screens.read,screens.status,screens.update,screens.workflow.concurrency}.test.ts`; `tests/unit/documentationWorkflow.transitions.test.ts`<br>`tests/06_documentation_workflow.test.ts`<br>Bruno folders `Screens`<br>frontend `src/test/{screens}`<br>MANUAL_CASES.md | Pass |  |
| FR-15 | BE-I35, BE-I36, BE-I38, BE-U06, BE-U11, LG-09, BR-Dependencies, FE-DEPENDENCY-MAP, MP-04 | backend auto, legacy, Bruno, frontend auto, manual production | `tests/integration/{dependencies.graph,dependencies.neighborhood,dependencies.snapshot}.test.ts`; `tests/unit/{contractModules5to8,dependencyGraph}.test.ts`<br>`tests/09_dependency_graph_tests.sql`<br>Bruno folders `Dependencies`<br>frontend `src/test/{dependency-map}`<br>MANUAL_CASES.md | Pass |  |
| FR-16 | BE-I35, BE-I36, BE-U11, BR-Dependencies, FE-DEPENDENCY-MAP | backend auto, Bruno, frontend auto | `tests/integration/{dependencies.graph,dependencies.neighborhood}.test.ts`; `tests/unit/dependencyGraph.test.ts`<br>Bruno folders `Dependencies`<br>frontend `src/test/{dependency-map}` | Pass | No manual case for the navigation to Miro. |
| FR-17 | BE-I74, BE-U40, BE-U41, BR-Search, FE-HOOKS, FE-LAYOUT, FE-SEARCH, MP-04 | backend auto, Bruno, frontend auto, manual production | `tests/integration/search.read.test.ts`; `tests/unit/{search.snippet,search.text}.test.ts`<br>Bruno folders `Search`<br>frontend `src/test/{hooks,layout,search}`<br>MANUAL_CASES.md | Pass |  |
| FR-18 | BE-I74, BE-I76, BR-Search, FE-SEARCH | backend auto, Bruno, frontend auto | `tests/integration/{search.read,search.snapshot}.test.ts`<br>Bruno folders `Search`<br>frontend `src/test/{search}` | Pass | No manual case. |
| FR-19 | BE-I11, BE-I20, BE-I28, BE-I29, BE-I30, BE-I32, BE-I65, BE-I85, BE-P01, BE-U08, BE-U09, BR-Dashboard, FE-DASHBOARD, MP-04, MP-06 | backend auto, Bruno, frontend auto, manual production | `tests/integration/{audit.recentActivity,collections.read,dashboard.activity,dashboard.jira,dashboard.read,dashboard.snapshot,screens.list,variables.read}.test.ts`; `tests/perf/dashboard.performance.test.ts`; `tests/unit/{dashboard.percent,dashboard.representation}.test.ts`<br>Bruno folders `Dashboard`<br>frontend `src/test/{dashboard}`<br>MANUAL_CASES.md | Pass |  |
| FR-20 | BE-I07, BE-I13, BE-I33, BE-I78, BE-U01, BE-U10, LG-02, LG-04, BR-Audit, FE-AUDIT, MP-04, MJ-04 | backend auto, legacy, Bruno, frontend auto, manual production, manual Jira | `tests/integration/{audit.cascade,audit.traceability,db.actAs,testDb.smoke}.test.ts`; `tests/unit/{audit.representation,db.actAs}.test.ts`<br>`tests/02_audit_privilege_tests.sql`; `tests/04_prisma_audit_e2e.test.ts`<br>Bruno folders `Audit`<br>frontend `src/test/{audit}`<br>MANUAL_CASES.md | Pass |  |
| FR-21 | BE-I07, BE-I09, BE-I10, BE-I12, BE-I13, BE-U01, BE-U02, BE-U06, BR-Audit, FE-AUDIT, MP-04, MP-05 | backend auto, Bruno, frontend auto, manual production | `tests/integration/{audit.cascade,audit.list,audit.performance,audit.snapshot,audit.traceability}.test.ts`; `tests/unit/{audit.representation,audit.service,contractModules5to8}.test.ts`<br>Bruno folders `Audit`<br>frontend `src/test/{audit}`<br>MANUAL_CASES.md | Pass |  |
| FR-22 | BE-I49, BE-I50, BE-I51, BE-U07, BR-Reports, FE-REPORTS, MP-04, MP-06 | backend auto, Bruno, frontend auto, manual production | `tests/integration/{reports.generate,reports.publication,reports.read}.test.ts`; `tests/unit/contractModules9to11.test.ts`<br>Bruno folders `Reports`<br>frontend `src/test/{reports}`<br>MANUAL_CASES.md | Pass |  |
| FR-23 | BE-I24, BE-I26, BE-I27, BR-Comments, FE-COMMENTS, MP-04, MP-05, MP-06 | backend auto, Bruno, frontend auto, manual production | `tests/integration/{comments.read,comments.update,comments.write}.test.ts`<br>Bruno folders `Comments`<br>frontend `src/test/{comments}`<br>MANUAL_CASES.md | Pass |  |
| FR-24 | BE-I67, BE-I70, BE-U13, LG-06, BR-Screens, BR-Comments, FE-REVIEW, MP-04, MP-05, MP-06 | backend auto, legacy, Bruno, frontend auto, manual production | `tests/integration/{screens.review,screens.workflow.concurrency}.test.ts`; `tests/unit/documentationWorkflow.transitions.test.ts`<br>`tests/06_documentation_workflow.test.ts`<br>Bruno folders `Screens`, `Comments`<br>frontend `src/test/{review}`<br>MANUAL_CASES.md | Pass |  |
| FR-25 | BE-I42, BE-I43, BE-I44, BE-U07, BE-U27, BR-Onboarding, BR-OnboardingProgress, FE-ONBOARDING, MP-04 | backend auto, Bruno, frontend auto, manual production | `tests/integration/{onboarding.consistency,onboarding.progress,onboarding.read}.test.ts`; `tests/unit/{contractModules9to11,onboarding.summary}.test.ts`<br>Bruno folders `Onboarding`, `OnboardingProgress`<br>frontend `src/test/{onboarding}`<br>MANUAL_CASES.md | Pass |  |
| FR-26 | BE-I77 | backend auto | `tests/integration/seed.test.ts` | Partial | Only the seeding mechanism is verified (`tests/integration/seed.test.ts`; `npm run db:seed` as described in `docs/phase4/OPERATIONS_NOTES.md`). The SAR content was not loaded into the system. |
| FR-27 | BE-I05, LG-01, BR-Applications, FE-APPLICATION, FE-APPLICATIONS, MP-04 | backend auto, legacy, Bruno, frontend auto, manual production | `tests/integration/applications.crud.test.ts`<br>`tests/01_integrity_tests.sql`<br>Bruno folders `Applications`<br>frontend `src/test/{application,applications}`<br>MANUAL_CASES.md | Pass |  |
| NFR-01 | BE-I15, BE-I17, LG-07, BR-Auth, FE-AUTH, FE-SESSION, MP-03 | backend auto, legacy, Bruno, frontend auto, manual production | `tests/integration/{auth.login,auth.session}.test.ts`<br>`tests/07_auth_rbac.test.ts`<br>Bruno folders `Auth`<br>frontend `src/test/{auth,session}`<br>MANUAL_CASES.md | Pass |  |
| NFR-02 | BE-I15, BE-U42, LG-07, MP-04 | backend auto, legacy, manual production | `tests/integration/auth.login.test.ts`; `tests/unit/seedConfig.test.ts`<br>`tests/07_auth_rbac.test.ts`<br>MANUAL_CASES.md | Pass |  |
| NFR-03 | BE-I01, BE-I02, BE-I03, LG-07, BR-Auth, BR-Users, FE-AUDIT, FE-LAYOUT, FE-REVIEW, FE-USERS, MS-01, MP-05, MP-06 | backend auto, legacy, Bruno, frontend auto, manual sandbox, manual production | `tests/integration/{app.authz-matrix,app.chain,app.registry}.test.ts`<br>`tests/07_auth_rbac.test.ts`<br>Bruno folders `Auth`, `Users`<br>frontend `src/test/{audit,layout,review,users}`<br>MANUAL_CASES.md | Pass | The authorization matrix covers every operation of the contract with its roles. |
| NFR-04 | BE-I02, BE-U05, BE-U15, BE-U16 | backend auto | `tests/integration/app.chain.test.ts`; `tests/unit/{config,jiraBaseUrl,jiraClient}.test.ts` | Partial | Outbound Jira calls require HTTPS and the API sets HSTS (`app.chain`, `jiraClient`, `config`). The HTTPS of the browser-to-API path in production is provided by the hosting service and no case records it. |
| NFR-05 | BE-I02, BE-I16, LG-08, BR-Auth, MP-03 | backend auto, legacy, Bruno, manual production | `tests/integration/{app.chain,auth.rateLimit}.test.ts`<br>`tests/08_request_validation.test.mjs`<br>Bruno folders `Auth`<br>MANUAL_CASES.md | Pass |  |
| NFR-06 | BE-I14, BE-I41, BE-U18, BE-U25, MJ-03 | backend auto, manual Jira | `tests/integration/{auth.logging,jira.webhook}.test.ts`; `tests/unit/{jiraLogging,loggerRedaction}.test.ts`<br>MANUAL_CASES.md | Pass |  |
| NFR-07 | FE-UI | frontend auto | frontend `src/test/{ui}` | Partial | No dedicated check of visual consistency. The shared component tests (FE-UI) and the manual navigation (MP-04 to MP-06) exercise it indirectly. The visual reference for the redesign is out of date (DEF-09). |
| NFR-08 | BE-I34, BE-I55, BE-U14, LG-08, BR-Screens, BR-LinkedItems, FE-API, MS-02 | backend auto, legacy, Bruno, frontend auto, manual sandbox | `tests/integration/{dbErrors,screens.concurrency}.test.ts`; `tests/unit/http.test.ts`<br>`tests/08_request_validation.test.mjs`<br>Bruno folders `Screens`, `LinkedItems`<br>frontend `src/test/{api}`<br>MANUAL_CASES.md | Pass |  |
| NFR-09 | - | - | - | Partial | The Power Apps vocabulary is in the schema and the API names (contract-vs-database check, Bruno). The learning curve was not measured with users. |
| NFR-10 | BE-I31, BE-I47, BE-I79, BE-P01, BE-P03 | backend auto | `tests/integration/{dashboard.scale,readModels.golden,transactions.sequential}.test.ts`; `tests/perf/{dashboard.performance,search.performance}.test.ts` | Partial | Measurements on disposable databases only: not a load of 30 concurrent users and not in production. What exists: `tests/perf/{search,dashboard,reports}.performance.test.ts` (outside `npm test`; `npm run test:perf`), the `PERF` lines of `dashboard.scale`, `dependencies.performance` and `audit.performance`, D-129 (measurement of the report worker) and the section "Pruebas bajo carga: P2028 en pantallas" of `docs/phase3/DECISIONS_FASE3.md` (`GET /screens/{id}`: about 17 ms to about 20 ms median with 50 components, 100 links and 20 navigations). |
| NFR-11 | BE-I10, BE-I35, BE-I37, BE-I45, FE-DEPENDENCY-MAP, MP-04 | backend auto, frontend auto, manual production | `tests/integration/{audit.performance,dependencies.graph,dependencies.performance,onboarding.scale}.test.ts`<br>frontend `src/test/{dependency-map}`<br>MANUAL_CASES.md | Pass |  |
| NFR-12 | BE-I49, BE-I53, BR-Reports, FE-REPORTS, MP-04 | backend auto, Bruno, frontend auto, manual production | `tests/integration/{reports.generate,reports.worker}.test.ts`<br>Bruno folders `Reports`<br>frontend `src/test/{reports}`<br>MANUAL_CASES.md | Pass |  |
| NFR-13 | MB-01, MB-02 | manual production | MANUAL_CASES.md | Partial | No availability measurement exists, so 99% of business hours is not verified. What exists: one always-on instance on the Render Starter plan (D-155), PITR with a 3-day window and an export (MB-01) and a dump restored with the same counts (MB-02). |
| NFR-14 | BE-I29, BE-I41, BE-I62, BE-I64, BE-U23, BR-Jira, FE-DASHBOARD, FE-LAYOUT, FE-SCREENS | backend auto, Bruno, frontend auto | `tests/integration/{dashboard.jira,jira.webhook,screens.jiraTicket.unavailable,screens.jiraTree}.test.ts`; `tests/unit/jiraView.test.ts`<br>Bruno folders `Jira`<br>frontend `src/test/{dashboard,layout,screens}` | Pass | The outage is tested against the simulator (`screens.jiraTicket.unavailable`); there is no manual outage case. |
| NFR-15 | - | inspection | `src/modules/` | Partial | The module folders exist in `src/modules/` and the layers are described in SDD §4.1. There is no automated check of the module boundaries. |
| NFR-16 | BE-I05, BR-Applications, FE-APPLICATION, FE-APPLICATIONS, MP-04 | backend auto, Bruno, frontend auto, manual production | `tests/integration/applications.crud.test.ts`<br>Bruno folders `Applications`<br>frontend `src/test/{application,applications}`<br>MANUAL_CASES.md | Pass |  |
| NFR-17 | BE-I08, BE-U03 | backend auto, static checks | `tests/integration/audit.contractEnums.test.ts`; `tests/unit/auditGate.test.ts`<br>`npm run lint`, `typecheck`, `format:check`, `audit:gate` | Pass | Static checks and the dependency audit gate. D-156 accepts one high advisory until 2026-12-31 (DEF-06). |
| NFR-18 | MP-01, MP-02, MP-03, MP-04, MP-05, MP-06, MP-07 | manual production | MANUAL_CASES.md | Pass | Chrome: MP-01 to MP-06. Microsoft Edge: MP-07. |
| NFR-19 | - | - | - | Partial | No case in this phase verifies the layout below 1440 px. SDD §11.5 reports earlier manual checks at narrower desktop widths; they were not repeated here. |
| NFR-20 | BE-I07, BE-I13, BE-I41, BE-I47, BE-I61, BE-I77, BE-I79, LG-02, LG-03, LG-04, BR-Audit, MP-04, MJ-04 | backend auto, legacy, Bruno, manual production, manual Jira | `tests/integration/{audit.cascade,audit.traceability,jira.webhook,readModels.golden,screens.jiraTicket,seed,transactions.sequential}.test.ts`<br>`tests/02_audit_privilege_tests.sql`; `tests/03_owner_immutability_tests.sql`; `tests/04_prisma_audit_e2e.test.ts`<br>Bruno folders `Audit`<br>MANUAL_CASES.md | Pass | Phase 2 checks 02, 03 and 04 are the evidence of the database triggers and privileges. |

## Appendix: catalog of test case IDs

Files linked to a requirement by scope, not by an ID written in the file: `app.authz-matrix`, `app.chain` and `app.registry`
(NFR-03; `app.chain` also NFR-04 and NFR-05), `http` and `dbErrors` (NFR-08), `auditGate` and `audit.contractEnums` (NFR-17),
`variables.originUsedIn` and `screens.etag.linked` (FR-05), `screens.etag` and `screens.etag.linked` (FR-10), `db.actAs`
(unit and integration, FR-20). The legacy tests 01 to 09 do not name requirements; their requirement is taken from the scope
in Table 74 of the SDD. The test 10 is a design baseline (a comparison table) and is not linked to a requirement.

### A.1 Backend unit tests (`tests/unit`, in `npm test`)

| ID | File |
|---|---|
| BE-U01 | `tests/unit/audit.representation.test.ts` |
| BE-U02 | `tests/unit/audit.service.test.ts` |
| BE-U03 | `tests/unit/auditGate.test.ts` |
| BE-U04 | `tests/unit/comments.etag.test.ts` |
| BE-U05 | `tests/unit/config.test.ts` |
| BE-U06 | `tests/unit/contractModules5to8.test.ts` |
| BE-U07 | `tests/unit/contractModules9to11.test.ts` |
| BE-U08 | `tests/unit/dashboard.percent.test.ts` |
| BE-U09 | `tests/unit/dashboard.representation.test.ts` |
| BE-U10 | `tests/unit/db.actAs.test.ts` |
| BE-U11 | `tests/unit/dependencyGraph.test.ts` |
| BE-U12 | `tests/unit/documentationWorkflow.test.ts` |
| BE-U13 | `tests/unit/documentationWorkflow.transitions.test.ts` |
| BE-U14 | `tests/unit/http.test.ts` |
| BE-U15 | `tests/unit/jiraBaseUrl.test.ts` |
| BE-U16 | `tests/unit/jiraClient.test.ts` |
| BE-U17 | `tests/unit/jiraGuard.test.ts` |
| BE-U18 | `tests/unit/jiraLogging.test.ts` |
| BE-U19 | `tests/unit/jiraMapping.test.ts` |
| BE-U20 | `tests/unit/jiraSignature.test.ts` |
| BE-U21 | `tests/unit/jiraSimulator.test.ts` |
| BE-U22 | `tests/unit/jiraTicketsRules.test.ts` |
| BE-U23 | `tests/unit/jiraView.test.ts` |
| BE-U24 | `tests/unit/keyedMutex.test.ts` |
| BE-U25 | `tests/unit/loggerRedaction.test.ts` |
| BE-U26 | `tests/unit/managedBootstrap.test.ts` |
| BE-U27 | `tests/unit/onboarding.summary.test.ts` |
| BE-U28 | `tests/unit/rateLimit.test.ts` |
| BE-U29 | `tests/unit/reconcile.test.ts` |
| BE-U30 | `tests/unit/repeats.test.ts` |
| BE-U31 | `tests/unit/reports.excel.test.ts` |
| BE-U32 | `tests/unit/reports.fileName.test.ts` |
| BE-U33 | `tests/unit/reports.fonts.test.ts` |
| BE-U34 | `tests/unit/reports.thread.test.ts` |
| BE-U35 | `tests/unit/reports.threadLoader.test.ts` |
| BE-U36 | `tests/unit/sandboxFixtures.guard.test.ts` |
| BE-U37 | `tests/unit/sandboxGraph.test.ts` |
| BE-U38 | `tests/unit/sandboxJiraEnv.test.ts` |
| BE-U39 | `tests/unit/search.order.test.ts` |
| BE-U40 | `tests/unit/search.snippet.test.ts` |
| BE-U41 | `tests/unit/search.text.test.ts` |
| BE-U42 | `tests/unit/seedConfig.test.ts` |
| BE-U43 | `tests/unit/testDb.unit.test.ts` |

### A.2 Backend integration tests (`tests/integration`, in `npm test`)

| ID | File |
|---|---|
| BE-I01 | `tests/integration/app.authz-matrix.test.ts` |
| BE-I02 | `tests/integration/app.chain.test.ts` |
| BE-I03 | `tests/integration/app.registry.test.ts` |
| BE-I04 | `tests/integration/app.serverErrors.test.ts` |
| BE-I05 | `tests/integration/applications.crud.test.ts` |
| BE-I06 | `tests/integration/applications.guard.test.ts` |
| BE-I07 | `tests/integration/audit.cascade.test.ts` |
| BE-I08 | `tests/integration/audit.contractEnums.test.ts` |
| BE-I09 | `tests/integration/audit.list.test.ts` |
| BE-I10 | `tests/integration/audit.performance.test.ts` |
| BE-I11 | `tests/integration/audit.recentActivity.test.ts` |
| BE-I12 | `tests/integration/audit.snapshot.test.ts` |
| BE-I13 | `tests/integration/audit.traceability.test.ts` |
| BE-I14 | `tests/integration/auth.logging.test.ts` |
| BE-I15 | `tests/integration/auth.login.test.ts` |
| BE-I16 | `tests/integration/auth.rateLimit.test.ts` |
| BE-I17 | `tests/integration/auth.session.test.ts` |
| BE-I18 | `tests/integration/collections.concurrency.test.ts` |
| BE-I19 | `tests/integration/collections.delete.test.ts` |
| BE-I20 | `tests/integration/collections.read.test.ts` |
| BE-I21 | `tests/integration/collections.update.test.ts` |
| BE-I22 | `tests/integration/collections.write.test.ts` |
| BE-I23 | `tests/integration/comments.concurrency.test.ts` |
| BE-I24 | `tests/integration/comments.read.test.ts` |
| BE-I25 | `tests/integration/comments.screenEtag.test.ts` |
| BE-I26 | `tests/integration/comments.update.test.ts` |
| BE-I27 | `tests/integration/comments.write.test.ts` |
| BE-I28 | `tests/integration/dashboard.activity.test.ts` |
| BE-I29 | `tests/integration/dashboard.jira.test.ts` |
| BE-I30 | `tests/integration/dashboard.read.test.ts` |
| BE-I31 | `tests/integration/dashboard.scale.test.ts` |
| BE-I32 | `tests/integration/dashboard.snapshot.test.ts` |
| BE-I33 | `tests/integration/db.actAs.test.ts` |
| BE-I34 | `tests/integration/dbErrors.test.ts` |
| BE-I35 | `tests/integration/dependencies.graph.test.ts` |
| BE-I36 | `tests/integration/dependencies.neighborhood.test.ts` |
| BE-I37 | `tests/integration/dependencies.performance.test.ts` |
| BE-I38 | `tests/integration/dependencies.snapshot.test.ts` |
| BE-I39 | `tests/integration/jira.webhook.concurrency.test.ts` |
| BE-I40 | `tests/integration/jira.webhook.secret.test.ts` |
| BE-I41 | `tests/integration/jira.webhook.test.ts` |
| BE-I42 | `tests/integration/onboarding.consistency.test.ts` |
| BE-I43 | `tests/integration/onboarding.progress.test.ts` |
| BE-I44 | `tests/integration/onboarding.read.test.ts` |
| BE-I45 | `tests/integration/onboarding.scale.test.ts` |
| BE-I46 | `tests/integration/pgOverlap.watcher.test.ts` |
| BE-I47 | `tests/integration/readModels.golden.test.ts` |
| BE-I48 | `tests/integration/reports.concurrency.test.ts` |
| BE-I49 | `tests/integration/reports.generate.test.ts` |
| BE-I50 | `tests/integration/reports.publication.test.ts` |
| BE-I51 | `tests/integration/reports.read.test.ts` |
| BE-I52 | `tests/integration/reports.sharedReads.test.ts` |
| BE-I53 | `tests/integration/reports.worker.test.ts` |
| BE-I54 | `tests/integration/sandboxGraph.load.test.ts` |
| BE-I55 | `tests/integration/screens.concurrency.test.ts` |
| BE-I56 | `tests/integration/screens.contract.test.ts` |
| BE-I57 | `tests/integration/screens.delete.test.ts` |
| BE-I58 | `tests/integration/screens.etag.linked.test.ts` |
| BE-I59 | `tests/integration/screens.etag.test.ts` |
| BE-I60 | `tests/integration/screens.jiraTicket.concurrency.test.ts` |
| BE-I61 | `tests/integration/screens.jiraTicket.test.ts` |
| BE-I62 | `tests/integration/screens.jiraTicket.unavailable.test.ts` |
| BE-I63 | `tests/integration/screens.jiraTicket.unsaved.test.ts` |
| BE-I64 | `tests/integration/screens.jiraTree.test.ts` |
| BE-I65 | `tests/integration/screens.list.test.ts` |
| BE-I66 | `tests/integration/screens.read.test.ts` |
| BE-I67 | `tests/integration/screens.review.test.ts` |
| BE-I68 | `tests/integration/screens.status.test.ts` |
| BE-I69 | `tests/integration/screens.update.test.ts` |
| BE-I70 | `tests/integration/screens.workflow.concurrency.test.ts` |
| BE-I71 | `tests/integration/screens.write.test.ts` |
| BE-I72 | `tests/integration/search.normalization.test.ts` |
| BE-I73 | `tests/integration/search.order.test.ts` |
| BE-I74 | `tests/integration/search.read.test.ts` |
| BE-I75 | `tests/integration/search.scale.test.ts` |
| BE-I76 | `tests/integration/search.snapshot.test.ts` |
| BE-I77 | `tests/integration/seed.test.ts` |
| BE-I78 | `tests/integration/testDb.smoke.test.ts` |
| BE-I79 | `tests/integration/transactions.sequential.test.ts` |
| BE-I80 | `tests/integration/users.concurrency.test.ts` |
| BE-I81 | `tests/integration/users.read.test.ts` |
| BE-I82 | `tests/integration/users.write.test.ts` |
| BE-I83 | `tests/integration/variables.concurrency.test.ts` |
| BE-I84 | `tests/integration/variables.originUsedIn.test.ts` |
| BE-I85 | `tests/integration/variables.read.test.ts` |
| BE-I86 | `tests/integration/variables.write.test.ts` |

### A.3 Backend performance tests (`tests/perf`, not in `npm test`)

| ID | File |
|---|---|
| BE-P01 | `tests/perf/dashboard.performance.test.ts` |
| BE-P02 | `tests/perf/reports.performance.test.ts` |
| BE-P03 | `tests/perf/search.performance.test.ts` |

### A.4 Phase 2 legacy checks (`npm run test:legacy`)

| ID | File | Scope |
|---|---|---|
| LG-01 | `tests/01_integrity_tests.sql` | Model integrity (37 checks) |
| LG-02 | `tests/02_audit_privilege_tests.sql` | Audit and privileges as docs_app (22) |
| LG-03 | `tests/03_owner_immutability_tests.sql` | Audit append-only even for docs_owner (3) |
| LG-04 | `tests/04_prisma_audit_e2e.test.ts` | End-to-end audit with Prisma (11) |
| LG-05 | `tests/05_jira_signature.test.ts` | Jira webhook signature (9) |
| LG-06 | `tests/06_documentation_workflow.test.ts` | Documentation workflow (15) |
| LG-07 | `tests/07_auth_rbac.test.ts` | Authentication, session and RBAC (35) |
| LG-08 | `tests/08_request_validation.test.mjs` | Request validation against the contract (14) |
| LG-09 | `tests/09_dependency_graph_tests.sql` | Dependency-graph query (7) |
| LG-10 | `tests/10_polymorphic_comparison.sql` | Polymorphic baseline vs adopted model (table of 20 rows) |

### A.5 Bruno folders (`bruno/docs-system-api`)

| ID | Folder |
|---|---|
| BR-Auth | `bruno/docs-system-api/Auth/` |
| BR-Users | `bruno/docs-system-api/Users/` |
| BR-Applications | `bruno/docs-system-api/Applications/` |
| BR-Screens | `bruno/docs-system-api/Screens/` |
| BR-Variables | `bruno/docs-system-api/Variables/` |
| BR-Collections | `bruno/docs-system-api/Collections/` |
| BR-Jira | `bruno/docs-system-api/Jira/` |
| BR-Dependencies | `bruno/docs-system-api/Dependencies/` |
| BR-Audit | `bruno/docs-system-api/Audit/` |
| BR-Search | `bruno/docs-system-api/Search/` |
| BR-Dashboard | `bruno/docs-system-api/Dashboard/` |
| BR-Reports | `bruno/docs-system-api/Reports/` |
| BR-Comments | `bruno/docs-system-api/Comments/` |
| BR-Onboarding | `bruno/docs-system-api/Onboarding/` |
| BR-OnboardingProgress | `bruno/docs-system-api/OnboardingProgress/` |
| BR-LinkedItems | `bruno/docs-system-api/LinkedItems/` |

### A.6 Frontend tests (`src/test` of the frontend repository)

| ID | Folder or file |
|---|---|
| FE-API | `src/test/api/` |
| FE-APP | `src/test/app/` |
| FE-APPLICATION | `src/test/application/` |
| FE-APPLICATIONS | `src/test/applications/` |
| FE-AUDIT | `src/test/audit/` |
| FE-AUTH | `src/test/auth/` |
| FE-COLLECTIONS | `src/test/collections/` |
| FE-COMMENTS | `src/test/comments/` |
| FE-DASHBOARD | `src/test/dashboard/` |
| FE-DEPENDENCY-MAP | `src/test/dependency-map/` |
| FE-HOOKS | `src/test/hooks/` |
| FE-LAYOUT | `src/test/layout/` |
| FE-ONBOARDING | `src/test/onboarding/` |
| FE-REPORTS | `src/test/reports/` |
| FE-REVIEW | `src/test/review/` |
| FE-ROUTES | `src/test/routes/` |
| FE-SCRIPTS | `src/test/scripts/` |
| FE-SCREENS | `src/test/screens/` |
| FE-SEARCH | `src/test/search/` |
| FE-SESSION | `src/test/session/` |
| FE-UI | `src/test/ui/` |
| FE-USERS | `src/test/users/` |
| FE-VARIABLES | `src/test/variables/` |
| FE-APP | `src/test/App.test.tsx` |
