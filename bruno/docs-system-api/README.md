# docs-system-api (Bruno collection)

Requests and assertions for every implemented operation, grouped by module: `Auth`, `Users`, `Applications`,
`Screens` (only the listing, until the screens module arrives), `Variables` and `Collections`. It runs against the isolated database
`docs_sandbox`, never against `docs_system`.

```bash
npm run test:api        # recreates docs_sandbox, starts the API on port 3001, runs the collection, cleans up
npm run sandbox:db      # only recreates and fills docs_sandbox (then: npm run sandbox:api, and open Bruno)
```

Every folder logs in by itself, creates the users it needs with random e-mails and names what it creates with a random
prefix, so the collection can run again on the same sandbox without recreating it. A run that is interrupted leaves
only rows with its own prefix, which no later run reads.

## Sandbox Fixtures

The API cannot yet create screens or screen links (they arrive with the screens module), so
`npm run sandbox:db` inserts them directly, after the seed, as an application named **Sandbox Fixtures**
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
