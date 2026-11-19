# Operations notes: a managed database and running the CLI from a local computer

For the first deployment on a managed PostgreSQL 16+ service (the default user is not a superuser and the database
already exists). Nothing here changes the code: `bootstrap/02_managed_database.sql` is new and the rest is how the
existing scripts behave. Commands are for Git Bash. Never paste a password in a command that is kept in the shell history:
read it into a variable with `read -rs` as shown.

## 1. Prepare the existing database (once)

`bootstrap/01_roles_and_database.sql` needs a superuser and creates the database. On a managed service use
`bootstrap/02_managed_database.sql` instead, as the default user of the service (it must own the database and have
CREATEROLE), with the EXTERNAL connection URL of the service:

```bash
read -rs -p 'Password of the default user: ' PGPASSWORD; export PGPASSWORD; echo
read -rs -p 'New password for docs_owner: ' OWNER_PWD; echo
read -rs -p 'New password for docs_app: ' APP_PWD; echo
psql "<external connection URL of the default user>" -v owner_pwd="$OWNER_PWD" -v app_pwd="$APP_PWD" \
     -f bootstrap/02_managed_database.sql
unset PGPASSWORD OWNER_PWD APP_PWD
```

It creates `docs_owner` and `docs_app` if they do not exist, applies to the current database (`current_database()`, no
fixed name) the permissions of script 01 (PUBLIC revoked, `CONNECT` and `TEMPORARY` for `docs_app`, owner of the `public`
schema = `docs_owner`, nobody else can create in it) and can be run again. Three things differ from script 01, and the
script comments explain each one:

- PostgreSQL 16+ gives a `CREATEROLE` user ADMIN on the roles it creates but not SET, and `ALTER SCHEMA ... OWNER TO` needs
  SET on the new owner, so the script grants itself `docs_owner WITH SET TRUE`, changes the owner and revokes it again.
- `docs_owner` does not own the database here, so it is given `CONNECT` (otherwise the revoke from PUBLIC locks it out) and
  `CREATE` (the first migration runs `CREATE SCHEMA IF NOT EXISTS "public"`, which PostgreSQL authorizes by `CREATE` on the
  database even when the schema exists; without it `prisma migrate deploy` stops with `permission denied for database`).
- The database stays owned by the default user, so the service keeps managing it.

It was simulated on a temporary local PostgreSQL 18 cluster with a `LOGIN CREATEROLE CREATEDB NOSUPERUSER` user: the script
(twice), the eight migrations as `docs_owner` and the seed as `docs_app` pass, and `docs_app` cannot insert, update, delete
or truncate `audit_log`, create tables or schemas, disable triggers or read `_prisma_migrations`. Not exercised: TLS. Use the
connection strings exactly as the service shows them (with the SSL mode it asks for).

## 2. Migrations and seed from a local computer, against an external URL

Who wins when a variable exists in the terminal and in the local `.env`: **the terminal**.

| What | Where | Behavior |
| ---- | ----- | -------- |
| `prisma migrate deploy` (`npm run db:deploy`) | `prisma.config.ts:1` `import 'dotenv/config'`, `prisma.config.ts:8` `env('DATABASE_URL')` | `dotenv` 18.0.4 does not override a variable that is already set (`override` is false by default): `.env` only fills what the terminal lacks |
| `npm run db:seed` | `src/scripts/seed.ts:7` imports `src/config/loadEnvFile.ts`; `src/config/loadEnvFile.ts:15` `process.loadEnvFile(path)` | Node's loader does not override variables already in the environment (the header of the file says so, line 2) |
| API (`npm start`) | `src/server.ts:7` imports `src/config/loadEnvFile.ts` | The same rule |

Checked on Node 22.23.3 with a throwaway `.env`: with `PROBE_VAR=from_terminal` set, both loaders keep `from_terminal` and
only add the variables that are missing. Also checked end to end: the migrations and the seed of the simulation above ran with
the variables in the terminal while the local `.env` was present, and went to the temporary cluster, not to the database of the
`.env`.

The risk is not a variable being overridden but one being **missing in the terminal**: it is then filled from the local `.env`,
with local values. Migrations need only `DATABASE_URL` (`SHADOW_DATABASE_URL` is not used by `migrate deploy`). The seed needs
all of `APP_DATABASE_URL`, `SEED_ADMIN_NAME`, `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` and `INTEGRATION_USER_EMAIL`, and uses
`BCRYPT_COST` if it exists: set every one in the terminal, or the administrator that is created would come from the local `.env`.
Read the line the seed prints (`Administrator <email>: created`) to confirm which one it used.

```bash
# migrations, as docs_owner (the URL of docs_owner; it never goes to the web service)
read -rs -p 'DATABASE_URL (docs_owner, external): ' DATABASE_URL; export DATABASE_URL; echo
npm run db:deploy
unset DATABASE_URL

# seed, as docs_app
read -rs -p 'APP_DATABASE_URL (docs_app, external): ' APP_DATABASE_URL; export APP_DATABASE_URL; echo
export SEED_ADMIN_NAME='<name>' SEED_ADMIN_EMAIL='<e-mail>' INTEGRATION_USER_EMAIL='<reserved account e-mail>'
read -rs -p 'SEED_ADMIN_PASSWORD (12-128 characters, letters and digits): ' SEED_ADMIN_PASSWORD; export SEED_ADMIN_PASSWORD; echo
npm run db:seed
unset APP_DATABASE_URL SEED_ADMIN_NAME SEED_ADMIN_EMAIL SEED_ADMIN_PASSWORD INTEGRATION_USER_EMAIL
```
