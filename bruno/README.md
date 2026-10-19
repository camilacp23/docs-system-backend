# API tests with Bruno

The collection `docs-system-api/` (Bruno OpenCollection YAML, created with Bruno 4.2.1) checks the **Auth** and
**Users** endpoints of the API against an isolated database. It never touches `docs_system`.

| Folder | Requests | Covers |
|---|---|---|
| `Auth` | 22 | login, refresh with rotation and reuse detection, logout, Origin check, login rate limit |
| `Users` | 36 | create, list, read, update with `If-Match`, role change, logical deactivation, reserved account, last administrator, session revocation, 413 |

Every request asserts status code, response body (error `code`, `message`, `details`) and the relevant headers
(`ETag`, `Location`, `Set-Cookie`, `Cache-Control`, `Retry-After`). Requests run in folder order: later ones use the
tokens and ids that earlier ones store in runtime variables, so run a whole folder (or the whole collection), not a
single request out of order.

## How the sandbox is isolated

- Database `docs_sandbox` is created from `docs_test_template` (built from `prisma/migrations`) and seeded with an
  administrator (`admin@sandbox.local`) and the reserved integration account. The scripts only ever create or drop that
  exact name.
- The administrator password is generated on every recreation and written to
  `docs-system-api/.env` (git-ignored). It is never read from the development `.env`, and it is never printed.
- The development `.env` only supplies the PostgreSQL host and the `docs_owner` / `docs_app` credentials.
- The sandbox API listens on port **3001** (the development API uses 3000) with `FRONTEND_ORIGIN=http://localhost:5173`.
  Its JWT key is generated at every start, so tokens do not survive a restart.
- Nothing weakens the server: the `rt` cookie keeps its `Secure` attribute. Bruno sends it to `http://localhost:3001`
  anyway, and the requests that depend on a specific cookie set it explicitly in the cookie jar from a script.

## From the Bruno app

1. `npm run sandbox:db` recreates and seeds `docs_sandbox` and writes `bruno/docs-system-api/.env`.
2. `npm run sandbox:api` starts the API on port 3001 and stays in the foreground (Ctrl+C stops it).
3. In Bruno (4.2.1): *Open Collection* → `bruno/docs-system-api`, choose the **sandbox** environment, then *Run*
   the collection or a folder. Close and reopen the collection after step 1 so Bruno re-reads `.env`.

The run can be repeated on the same database: each run creates users with random e-mails. The collection makes a few
failed logins on purpose (administrator, reserved account), and the login limit is 5 failures per e-mail in 15
minutes. After about five runs in a row, run `npm run sandbox:db` again (and restart the API) or wait 15 minutes.

## From the terminal

```bash
npm run test:api
```

It recreates `docs_sandbox`, starts the API on port 3001, runs the collection with the Bruno CLI
(`@usebruno/cli`, same version as the app) and, **always** (also when a check fails or the script is interrupted),
stops the API and drops `docs_sandbox`. The exit code is 0 only when every request and assertion passed. It refuses to
start if port 3001 is already in use, for example by `npm run sandbox:api`.

To run only the CLI against an API you started yourself:

```bash
cd bruno/docs-system-api
npx bru run --env sandbox -r          # whole collection
npx bru run Auth --env sandbox -r     # one folder
```

## Prerequisites

PostgreSQL with the roles of `bootstrap/01_roles_and_database.sql` and a `.env` as described in `.env.example`
(`DATABASE_URL` for `docs_owner`, `APP_DATABASE_URL` for `docs_app`). Credentials may also come from `pgpass`.

## What is versioned

Requests, folders and `environments/sandbox.yml`. The environment file refers to the secrets as
`{{process.env.SANDBOX_*}}`; their values live only in the git-ignored `docs-system-api/.env`.
