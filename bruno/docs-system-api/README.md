# docs-system-api (Bruno collection)

Requests and assertions for every implemented operation, grouped by module: `Auth`, `Users`, `Applications`,
`Screens`, `Variables`, `Collections` and `Jira` (529 requests and 1340 assertions in all). It runs against the isolated database
`docs_sandbox`, never against `docs_system`.

```bash
npm run test:api        # recreates docs_sandbox, starts the API on port 3001, runs the collection, cleans up
npm run sandbox:db      # only recreates and fills docs_sandbox (then: npm run sandbox:api, and open Bruno)
```

Every folder logs in by itself, creates the users it needs with random e-mails and names what it creates with a random
prefix, so the collection can run again on the same sandbox without recreating it. A run that is interrupted leaves
only rows with its own prefix, which no later run reads.

## Sandbox Fixtures

The API cannot create assignments of variables to collections, nor links already in place when a run starts, so
`npm run sandbox:db` inserts screens and links directly, after the seed, as an application named **Sandbox Fixtures**
(`scripts/lib/sandboxFixtures.ts`, which reuses `tests/helpers/fixtures.ts`). Its data is fixed and the requests never
change it; the requests that fail on purpose are rolled back.

| Element                              | What it has                                                                                                           | What it is for                                                                                                         |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Screens `Sandbox Screen A` and `B`   | Two screens besides App (OnStart)                                                                                     | Origin screens of variables; `GET /screens`                                                                            |
| Variable `gSandboxShared`            | GLOBAL, TEXT, DEV and PROD, origin A, READ link from B, SET assignment in `colSandbox` (screen A, `OnVisible`)        | Dependencies of a variable; `SCOPE_CONFLICT` (a PUT to CONTEXT collides with the SET assignment)                       |
| Variable `gSandboxLinked`            | GLOBAL, TEXT, DEV and PROD, origin A, READ link from B, no assignments                                                | `CONTEXT_SCREEN_MISMATCH`, with origin (PUT to CONTEXT, origin A) and without it (PUT to CONTEXT, no origin)           |
| Collection `colSandbox`              | DEV, no screen link (undocumented)                                                                                    | Holds the assignment of `gSandboxShared`; `undocumented=true`                                                          |
| Collection `colSandboxDocumented`    | DEV, READ link from screen A (documented)                                                                             | `undocumented=false` vs `true` (the API cannot create a `screen_collection` link)                                      |

`gSandboxLinked` exists apart from `gSandboxShared` because the SET assignment makes `SCOPE_CONFLICT` come first on any
PUT to CONTEXT, so the screen mismatch cannot be reached through that variable.

The `Collections` folder lists `q=colSandbox` (a contains search), so no name created by a run may contain
"colSandbox"; it never derives from, or assigns variables to, either fixture collection.

The variables a run creates (`<prefix>Global`, `Other`, `Ctx`, `Free`, with a random prefix such as `qk3j9x2a`) also live
in Sandbox Fixtures, because only its screens can be an origin screen; the run deletes them at the end and its lists
filter by the prefix. The archived-application requests use an application created by the run.

## Screens folder

118 requests (the first seven read the listing of Sandbox Fixtures and never change it). Like `Variables` and
`Collections`, it logs in the administrator, creates a Developer and a Reader with random e-mails and an application of
its own (`Screens <suffix>`), and names everything it creates with a random prefix. The links, uses and navigations of
its screens point only to a variable and a collection created in that application; the Sandbox Fixtures data is used
only by requests that are rejected before writing (`CROSS_APPLICATION`). At the end it deletes what it created and
lists with `q=<prefix>` that `total` is 0 (the run application keeps only its App (OnStart) screen, and the fixtures
are checked to be untouched). Like the other folders it does not deactivate its two users.

| Requests | Covers |
| -------- | ------ |
| 08-15    | Setup: Developer and Reader, run application, its App (OnStart) screen, a variable and a collection |
| 16-28    | Create: `UNDOCUMENTED` without content and `DRAFT` with content (D-81), `Location` and `ETag`; complete screen with components, uses, links and navigation; 409 `DUPLICATE_NAME` (`container`); 400 (required list omitted, repeated component name with position, `usedIn` `origin`); 404 destination screen; 403 Reader; 422 `CROSS_APPLICATION` for each kind of link |
| 29-32    | Read: 200 as Reader, 304 with `If-None-Match`, 404, 400 |
| 33-50    | Update: 412 with `currentETag`; a PUT without changes keeps the `ETag` (D-71); swap of two component names keeping the ids; `UNDOCUMENTED` to `DRAFT`; 400 (self navigation `self`, repeated name, `origin`, omitted list); 404 for a nested id of another screen (D-75), a missing destination and a missing screen; 403; 409; 422 `CROSS_APPLICATION`; nothing changed by the failed requests |
| 51-61    | Context variables (D-64, D-85): `CONTEXT_SCREEN_MISMATCH` with origin and without origin (the origin screen is deleted first), in PUT and in POST (`screenId: null`); the origin row survives a PUT that omits it |
| 62-64    | App (OnStart) (D-87): 422 `APP_CONTEXT_PROTECTED` when deleted and when renamed; its template is edited normally |
| 65-89    | Workflow (D-81, D-82, D-88): errors of `/status` (400, 403, 404, 412, `INVALID_TRANSITION` with `from` and `to`), `TEMPLATE_INCOMPLETE` with `details.fields` in the order of SRS Table 28, `/review` as Developer (403) and `NOT_IN_REVIEW`, submit, 422 `SCREEN_IN_REVIEW` on PUT and DELETE, withdraw, submit again, RETURN without `comment` (400), with only spaces (`COMMENT_REQUIRED`) and valid, APPROVE with and without comment (`commentCount`), editing an `APPROVED` screen returns it to `IN_PROGRESS`, reopen |
| 90-98    | Archived application: 422 `APPLICATION_ARCHIVED` in POST, PUT, DELETE, `/status` and `/review`; still readable; PUT works again once unarchived |
| 99-103   | Delete: 403 Reader, 204, 404 afterwards, twice and for a missing id |
| 104-118  | Cleanup: deletes, `total` 0 by prefix, fixtures untouched |

To check that a run cut half-way leaves nothing that a later run reads, run the folder against a sandbox you keep
(`npm run sandbox:db`, `npm run sandbox:api`, then `npx bru run Screens --env sandbox -r` from this directory), stop
the CLI by its PID in the middle (for example while the run application is archived) and run the folder again: it
passes, because each run works on its own application and prefix.

### Guard

The script inserts only into the database named exactly `docs_sandbox`: it checks the name in the connection URL
before connecting and `current_database()` after connecting, and refuses anything else (`docs_system`, `docs_shadow`,
`docs_test_*`, ...). `tests/unit/sandboxFixtures.guard.test.ts` covers it.

### Variables written to `.env`

`npm run sandbox:db` writes `bruno/docs-system-api/.env` (git-ignored; never commit it). The environment
`environments/sandbox.yml` reads these as `process.env`:

| `.env` variable                        | Bruno variable     | Value                              |
| -------------------------------------- | ------------------ | ---------------------------------- |
| `SANDBOX_ADMIN_EMAIL`                  | `adminEmail`       | Administrator e-mail               |
| `SANDBOX_ADMIN_PASSWORD`               | `adminPassword`    | Generated per sandbox              |
| `SANDBOX_RESERVED_EMAIL`               | `reservedEmail`    | Reserved integration account       |
| `SANDBOX_RESERVED_ID`                  | `reservedId`       | Id of the reserved account         |
| `SANDBOX_FIXTURES_APP_ID`              | `fixturesAppId`    | Sandbox Fixtures application       |
| `SANDBOX_FIXTURES_SCREEN_A_ID`         | `screenAId`        | Sandbox Screen A                   |
| `SANDBOX_FIXTURES_SCREEN_B_ID`         | `screenBId`        | Sandbox Screen B                   |
| `SANDBOX_FIXTURES_VARIABLE_ID`         | `sharedVariableId` | `gSandboxShared`                   |
| `SANDBOX_FIXTURES_LINKED_VARIABLE_ID`  | `linkedVariableId` | `gSandboxLinked`                   |
| `SANDBOX_FIXTURES_COLLECTION_ID`       | `collectionId`     | `colSandbox`                       |
| `SANDBOX_FIXTURES_DOCUMENTED_COLLECTION_ID` | `documentedCollectionId` | `colSandboxDocumented`  |

## Jira folder

125 requests (`seq` 7, after `Collections`), always against the local Jira simulator: no request points to another
host, and every request that goes to `{{jiraSimUrl}}` first refuses to be sent unless that URL is
`http://127.0.0.1` or `http://localhost`. Like the other folders it logs in the administrator, creates a Developer and a
Reader with random e-mails and an application of its own (`Jira <suffix>`), names what it creates with a random prefix
and lists with `q=<prefix>` that `total` is 0 at the end (the run application keeps only its App (OnStart) screen and
the tickets of that screen). The Jira issues it creates stay in the simulator, which does not persist: their summaries
start with the prefix and their ids never repeat, so no later run reads them. Sandbox Fixtures is only read.

| Requests | Covers |
| -------- | ------ |
| 01-20    | Setup: users, run application, `faults/clear` and a state check of the simulator (whatever an interrupted run left is cleared), five screens, `Gamma` taken to `IN_REVIEW`, and two seed tickets on `Hook` |
| 21-41    | Create: first ticket with a new Epic, Story and Subtask (`created` in order, `url`, no `Location`, Epic summary `<screen> (<application>)`), second ticket with `storyId`, new Story under the existing Epic, each step checked in the simulator; 422 `STORY_NOT_IN_SCREEN` (missing, out of range, other screen, an Epic, a Subtask); 400 `required`, `singleLine` and over 255 characters; 401, 403 Reader, 404; none of the rejected requests reaches Jira; App (OnStart) and an `IN_REVIEW` screen accept tickets |
| 42-57    | Failures of Jira: `JIRA_UNAVAILABLE` before creating (also for a Subtask of an existing Story); `JIRA_PARTIAL_FAILURE` after the Epic (Epic message, no `storyId`) and after the Story (with `storyId`); each retry creates only what is missing and `GET /__sim/state` shows no duplicate |
| 58-76    | Tree: without refresh (the call log of the simulator does not grow), `ETag` and 304, refresh with no change (no row is written), refresh after a status change and a rename made in the simulator, refresh while Jira fails (200, `stale: true`, exactly one faulted call), Reader refresh, 404, empty tree with and without refresh |
| 77-100   | Webhook: signed event from the simulator (204, visible in the tree with the event `timestamp`), duplicate, altered body, no signature and another secret (401 `INVALID_SIGNATURE`), older event after a newer one, issue not tracked, `issue_created`, a body with its own spacing and a `é` escape (byte for byte), signed but invalid bodies (400), `deleted` (the row and its children leave the tree) |
| 101-109  | Archived application: 422 `APPLICATION_ARCHIVED`, refresh answers the local copy with `stale: true`, and an event is acknowledged (204) without changing anything; the simulator received no call meanwhile |
| 110-125  | Cleanup: `Gamma` leaves review, six screens deleted (their tickets go with them), `total` 0, fixtures untouched, simulator without pending faults |

### Circuit breaker and time

The client opens its circuit after 5 consecutive failures and keeps it open for 60 s, and a timeout takes 10 s. The folder
reaches none of them and waits for nothing (no `delay`, no `timeout` fault):

- Only two kinds of failure are used. A failed creation (`503` on `create`) is not retried, and a failed read is a `429`
  with `Retry-After: 11` (more than the 10 s the client is willing to wait, so it fails at once, without backoff).
  Every fault is armed with `count: 1` and the next state check shows it consumed.
- Each failure is followed by a call to Jira that succeeds before the next failure, so the streak never passes 1 (2 if a
  cut run left one). Those calls close the streak: they are the creation of the Epic, the retry, or a successful refresh.
- `POST /__sim/faults/clear` (not `/__sim/reset`, which would forget the issues the database refers to) opens the folder
  and the last request checks nothing is left pending.
- `GET /__sim/state` records the calls the API made (`calls`), so "without refresh" and "rejected" are proved by the log
  not growing, and a failed refresh by exactly one faulted call.

### Webhook bodies

The simulator returns each delivery as `rawBody` plus its headers. The request that delivers it has an empty body and a
before-request script with `req.setBody(raw, { raw: true })`: a JSON body written in the request would be interpolated
and, if it is not valid JSON, serialized again by the HTTP client, which would break the signature. Bodies the simulator
cannot produce (not tracked, `issue_created`, signed but invalid, with its own spacing) are signed in the script with
`crypto-js` (HMAC-SHA256) and `jiraWebhookSecret`. The spaced body proves the bytes arrive untouched, which the
simulator's compact bodies could not. A signed body that is not valid JSON at all cannot be sent as `application/json`
(the client would quote it), so the 400 cases use valid JSON that is not an event.

### Ids that never repeat

`jira_ticket` has unique indexes on the Jira issue id and key, and `docs_sandbox` outlives the simulator. `sandbox:jira`
therefore starts its issue ids and key numbers from `Date.now() * 1000` (16 digits, `TECHEA-1793676081460000`) and its
`/__sim/reset` never rewinds them, so a restarted simulator cannot give a new issue the id or key of a row an earlier run
left behind. `npm run test:api` starts a fresh database and a fresh simulator together, so this only matters when you run
the pieces by hand.

To check an interrupted run, run the folder with `npx bru run Jira --env sandbox -r --delay 200` from this directory, stop
the CLI by its PID after some request (for example after the one that arms a fault), restart the simulator if you like and
run the folder again: it passes, because the first requests clear the simulator and each run works on its own
application and prefix.
