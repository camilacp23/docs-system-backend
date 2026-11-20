# Manual cases

Phase 4. Manual verification records, as confirmed by the author of the project. They are linked to requirements in
[TRACEABILITY_MATRIX.md](TRACEABILITY_MATRIX.md); the method is in [TEST_PLAN.md](TEST_PLAN.md). "Not recorded" means that
the detail was not kept and is not reconstructed here.

Result values: Pass, Fail, Not run. Every case below is Pass.

## 1. Sandbox (2026-11-19)

| ID | Role | Steps (summary) | Expected result | Obtained result | Date | Environment |
| -- | ---- | --------------- | --------------- | --------------- | ---- | ----------- |
| MS-01 | Administrator, Developer, Reader | ETag of the screen with the three roles: rename a linked variable; read the screen; read it again with the ETag; check that the ETag has four segments; edit the screen; open "Used in" of the origin | The read after the rename returns 200 with the new data and then 304; the ETag has four segments; the edit does not return 412; "Used in" of the origin is shown | Pass. As expected, with the three roles | 2026-11-19 | Sandbox (browser: not recorded) |
| MS-02 | Administrator, Developer, Reader | Frontend with the contract 0.5.1: favicon, opaque ETag, pages that load, the three roles, browser console | The favicon loads, the ETag is handled as an opaque value, the pages load for each role and the console shows no errors | Pass. As expected | 2026-11-19 | Sandbox (browser: not recorded) |

## 2. Production (2026-11-19 and 2026-11-20)

MP-01 to MP-06 were run in Google Chrome. MP-07 was run in Microsoft Edge.

| ID | Role | Steps (summary) | Expected result | Obtained result | Date | Environment |
| -- | ---- | --------------- | --------------- | --------------- | ---- | ----------- |
| MP-01 | None, then false credentials | API: a request without a token; a login with false credentials | 401 without a token; `INVALID_CREDENTIALS` with false credentials | Pass. As expected | 2026-11-19 | Production, Google Chrome |
| MP-02 | None | Static Site: a `/api/*` path; a deep route; the favicon | The rewrite answers `/api/*` with JSON from the API; a deep route is served `index.html`; the favicon is served | Pass. As expected | 2026-11-19 | Production, Google Chrome |
| MP-03 | Not recorded | Sign in and renew the session with F5 through the rewrite | The session starts and survives the reload; the cookie is `SameSite=Strict` | Pass. As expected | 2026-11-19 | Production, Google Chrome |
| MP-04 | Administrator | Smoke test of 24 steps (part for this role): application SAR; Developer and Reader users; screens Home and Detail; global and context variables with origin and "Used in"; collection with fields and assignment; complete template with a component; navigation and links; review flow with return and approval; comments; dependency map in its three views; quick search and advanced search with only a filter; dashboard; PDF report published and Excel report not published, with download; audit; onboarding progress; change of own password with sign-out | Each step works as specified for the Administrator | Pass. As expected (steps per item: not recorded) | 2026-11-19 | Production, Google Chrome |
| MP-05 | Developer | Smoke test (part for this role): menu without administration; review page read-only; edit and comment; audit with only their own actions | The Developer cannot reach administration or decide a review, can edit and comment, and sees only their own actions in the audit | Pass. As expected | 2026-11-19 | Production, Google Chrome |
| MP-06 | Reader | Smoke test (part for this role): read-only access; reports list; dashboard; `/audit`; comments | Read-only; only published reports; the dashboard has no recent activity; `/audit` shows "No access"; the Reader can comment | Pass. As expected | 2026-11-19 | Production, Google Chrome |
| MP-07 | Administrator | Sign in; reload with F5; navigate Screens, Dependency map and Reports; read the console | The session starts and survives the reload; the three pages load; no console errors | Pass. As expected | 2026-11-20 | Production, Microsoft Edge |

## 3. Jira Cloud TECHEA, from production (2026-11-19)

Ticket keys, times and exact URLs: not recorded. The browser: not recorded.

| ID | Role | Steps (summary) | Expected result | Obtained result | Date | Environment |
| -- | ---- | --------------- | --------------- | --------------- | ---- | ----------- |
| MJ-01 | Not recorded | Check the Jira indicator; create an Epic, a Story and a Subtask from a screen | The indicator shows connected; the three tickets are created | Pass. As expected | 2026-11-19 | Production, Jira Cloud TECHEA |
| MJ-02 | Not recorded | Create a second to-do on the screen whose Story already exists | The existing Story is used; no second Epic and no second Story | Pass. As expected | 2026-11-19 | Production, Jira Cloud TECHEA |
| MJ-03 | Not recorded | Register the webhook: URL of the API, JQL `project = TECHEA`, events issue updated and issue deleted, with a secret | The webhook is registered | Pass. As expected | 2026-11-19 | Production, Jira Cloud TECHEA |
| MJ-04 | Not recorded | Change the status of a ticket in Jira; reload the screen without pressing Refresh; read the delivery log in Jira and the audit | The new status shows after the reload; the delivery is 204; the change is attributed to "Integración Jira" in the audit | Pass. As expected | 2026-11-19 | Production, Jira Cloud TECHEA |
| MJ-05 | Not recorded | Delete a ticket in Jira; reload the screen | The deletion is reflected locally | Pass. As expected | 2026-11-19 | Production, Jira Cloud TECHEA |
| MJ-06 | None (deliveries) | Send a delivery with an invalid signature and another without a signature | Both are 401 `INVALID_SIGNATURE` | Pass. As expected | 2026-11-19 | Production |

## 4. Backup (2026-11-19)

| ID | Role | Steps (summary) | Expected result | Obtained result | Date | Environment |
| -- | ---- | --------------- | --------------- | --------------- | ---- | ----------- |
| MB-01 | Not applicable | Check point-in-time recovery (PITR) in Render and create an export | PITR is available (3-day window of the Hobby plan) and the export is created | Pass. As expected | 2026-11-19 | Production (Render Postgres) |
| MB-02 | Not applicable | `pg_dump` as `docs_owner`; `pg_restore` into a disposable local database; compare | The restored database has the same counts in nine tables and the 8 migrations | Pass. As expected (the nine tables: not recorded) | 2026-11-19 | Production dump, restored on a disposable local database |

## 5. Pending

No case is pending. MP-07, the Microsoft Edge case for NFR-18, was still Not run when the other production cases were recorded (2026-11-19). It was run on 2026-11-20 and is Pass.
