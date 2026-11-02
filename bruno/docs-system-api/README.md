# docs-system-api (Bruno collection)

Requests and assertions for every implemented operation, grouped by module: `Auth`, `Users`, `Applications`,
`Screens`, `Variables` and `Collections` (404 requests and 1034 assertions in all). It runs against the isolated database
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
