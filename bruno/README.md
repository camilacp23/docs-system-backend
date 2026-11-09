# API tests with Bruno

The collection `docs-system-api/` (Bruno OpenCollection YAML, created with Bruno 4.2.1) checks the **Auth**,
**Users** and **Applications** endpoints of the API against an isolated database. It never touches `docs_system`.

| Folder | Requests | Covers |
|---|---|---|
| `Auth` | 22 | login, refresh with rotation and reuse detection, logout, Origin check, login rate limit |
| `Users` | 36 | create, list, read, update with `If-Match`, role change, logical deactivation, reserved account, last administrator, session revocation, 413 |
| `Applications` | 32 | register (App (OnStart) screen, `Location`, `ETag`), duplicate name, list with `q` / `status`, get, `If-Match` 412, full replacement, archive and unarchive, role matrix (Developer and Reader read, cannot write) |
| `Dependencies` | 55 | dependency graph (FR-15): every node and edge variant and its own fields, the order, `ETag` and 304, `types` / `environment` filters, neighborhood with `depth` 1 to 3 and cycles of `DERIVES_FROM` and `NAVIGATES_TO`, 401 / 404 / 400, Reader and Developer roles; reads Sandbox Fixtures without changing it |
| `Audit` | 54 | audit history (FR-20, FR-21): the history of a run application and of single elements (create, update, delete, the review event, a field of a collection, a password change without its value), `ETag` and 304, filters, inclusive `from` / `to` to the millisecond, pagination, the empty page for an unknown application, the Developer's own actions and the `OWN_ACTIONS` 403, the 400 rules (400 before 403), 401 / 403 Reader; the records of deleted elements remain after the cleanup; reads Sandbox Fixtures without changing it |

Every request asserts status code, response body (error `code`, `message`, `details`) and the relevant headers
(`ETag`, `Location`, `Set-Cookie`, `Cache-Control`, `Retry-After`). Requests run in folder order: later ones use the
tokens and ids that earlier ones store in runtime variables, so run a whole folder (or the whole collection), not a
single request out of order.

## How the sandbox is isolated

- Database `docs_sandbox` is created from `docs_test_template` (built from `prisma/migrations`) and seeded with an
  administrator (`admin@sandbox.local`) and the reserved integration account. The scripts only ever create or drop that
  exact name.
- The administrator password is generated on every recreation and written to
  `docs-system-api/.env` (git-ignored), together with the real id of the reserved account (`SANDBOX_RESERVED_ID`,
  read from the database by its e-mail because the API never lists it). It is never read from the development `.env`, and it is never printed.
- The development `.env` only supplies the PostgreSQL host and the `docs_owner` / `docs_app` credentials.
- The sandbox API listens on port **3001** (the development API uses 3000) with `FRONTEND_ORIGIN=http://localhost:5173`.
  Its JWT key is generated at every start, so tokens do not survive a restart.
- Nothing weakens the server: the `rt` cookie keeps its `Secure` attribute. Bruno sends it to `http://localhost:3001`
  anyway, and the requests that depend on a specific cookie set it explicitly in the cookie jar from a script.
- Jira is never the real one. `npm run sandbox:jira` starts a local Jira simulator on port **3002** (listening on
  127.0.0.1 only; its control endpoints are under `/__sim/`). `npm run sandbox:db` generates its credentials and a
  webhook secret on every run and writes them to the same git-ignored `docs-system-api/.env`
  (`SANDBOX_JIRA_BASE_URL`, `SANDBOX_JIRA_EMAIL`, `SANDBOX_JIRA_API_TOKEN`, `SANDBOX_JIRA_WEBHOOK_SECRET`). The sandbox API
  receives them as its `JIRA_*` variables and ignores any `JIRA_*` of the development `.env`; the sandbox environment
  of the collection exposes the URL and the webhook secret as `jiraSimUrl` and `jiraWebhookSecret`. The scripts refuse to
  run if the URL does not point to localhost or 127.0.0.1.

## From the Bruno app

1. `npm run sandbox:db` recreates and seeds `docs_sandbox` and writes `bruno/docs-system-api/.env`.
2. `npm run sandbox:api` starts the API on port 3001 and stays in the foreground (Ctrl+C stops it). Start
   `npm run sandbox:jira` in another terminal for the Jira simulator (without it the API still starts, with Jira
   unavailable).
3. In Bruno (4.2.1): *Open Collection* → `bruno/docs-system-api`, choose the **sandbox** environment, then *Run*
   the collection or a folder. Close and reopen the collection after step 1 so Bruno re-reads `.env`.

The run can be repeated on the same database: each run creates users with random e-mails and applications with a random name (`SAR <suffix>`). The collection makes a few
failed logins on purpose (administrator, reserved account), and the login limit is 5 failures per e-mail in 15
minutes. After about five runs in a row, run `npm run sandbox:db` again (and restart the API) or wait 15 minutes.

## From the terminal

```bash
npm run test:api
```

It recreates `docs_sandbox`, starts the Jira simulator on port 3002 and the API on port 3001, runs the collection with the Bruno CLI
(`@usebruno/cli`, same version as the app) and, **always** (also when a check fails or the script is interrupted),
stops the API and the simulator and drops `docs_sandbox`. The exit code is 0 only when every request and assertion passed. It refuses to
start if port 3001 or 3002 is already in use, for example by `npm run sandbox:api` or `npm run sandbox:jira`.

To run only one folder (or some requests) in the isolated database, give their paths after `--`:

```bash
npm run test:api -- Audit
```

Audit records are never deleted (NFR-20), so a repeated run adds to the same history. The folder creates its own users and
application with random names on every run, and every assertion is limited to those users, that application or its
elements, never to totals of the whole log; the cleanup deletes the elements it created (the lists end with `total` = 0)
and the records of the run stay by design. To check that a run that stopped half way does not break the next one,
`API_FIRST_PASS` runs some requests first (their result is ignored) and then the requested ones on the same database:

```bash
API_FIRST_PASS="Audit/01-setup-administrator-login-200.yml Audit/02-setup-create-developer-201.yml" npm run test:api -- Audit
```

To run only the CLI against an API you started yourself:

```bash
cd bruno/docs-system-api
npx bru run --env sandbox -r          # whole collection
npx bru run Auth --env sandbox -r     # one folder
```

## A graph of about 500 nodes in the sandbox

To see the dependency map at department scale, load an application through the API (so every row is validated and
audited), with `npm run sandbox:db` and `npm run sandbox:api` running:

```bash
npm run sandbox:graph                              # 500 nodes, random prefix
npm run sandbox:graph -- --nodes 300 --prefix demo1  # 50 to 1000 nodes; the prefix is 3 to 12 letters or digits
```

It creates the application `Graph demo <prefix>` with screens, variables, collections and components, every kind of edge and
cycles of `DERIVES_FROM` and `NAVIGATES_TO`, then prints the node and edge counts, how long `GET /dependencies/graph` took,
and two URLs to look at. Each run uses its own application, so it can run twice on the same sandbox. It only talks to
`http://localhost:3001/api/v1` (there is no option to change it), refuses to write unless it finds the application
**Sandbox Fixtures**, and reads the administrator credentials from `docs-system-api/.env` without printing them.

## Prerequisites

PostgreSQL with the roles of `bootstrap/01_roles_and_database.sql` and a `.env` as described in `.env.example`
(`DATABASE_URL` for `docs_owner`, `APP_DATABASE_URL` for `docs_app`). Credentials may also come from `pgpass`.

## What is versioned

Requests, folders and `environments/sandbox.yml`. The environment file refers to the secrets as
`{{process.env.SANDBOX_*}}`; their values live only in the git-ignored `docs-system-api/.env`.
