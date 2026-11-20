# Maintenance guide

Routine and exceptional tasks of the production system. The setup and the release procedure are in
[DEPLOYMENT.md](DEPLOYMENT.md); preparing the database and running migrations from a local computer is in
[OPERATIONS_NOTES.md](../phase4/OPERATIONS_NOTES.md). Commands are for Git Bash. Never write a password, token or URL with a
password in a command that stays in the shell history: read it with `read -rs`, use it and `unset` it. Do not paste with
Ctrl+V into the silent prompt of Git Bash (incident 4 in [DEFECTS.md](../phase4/DEFECTS.md)); verify every password by connecting
with it.

## 1. Where each secret lives

| Secret | Where it lives | Never |
| ------ | -------------- | ----- |
| `APP_DATABASE_URL` (user `docs_app`) | Environment of `tech-docs-api` in Render, and the operator's password manager | In the repository |
| URL and password of `docs_owner` | Operator's password manager only; used from the operator's computer for migrations | In Render (D-155) |
| Password of the default user of the database | Operator's password manager | In the repository |
| `JWT_KEYS` | Environment of `tech-docs-api` and the operator's password manager | In the repository |
| `JIRA_API_TOKEN` | Environment of `tech-docs-api` and the operator's password manager | In the repository |
| `JIRA_WEBHOOK_SECRET` | Environment of `tech-docs-api` and the Secret field of the webhook in Jira | In the repository |
| Passwords of the application users | Only as bcrypt hashes in the database; the user keeps the password | In logs and in any document |

Secrets live only in Render and in the operator's password manager, never in the repository. `.env` is git-ignored and
`.env.example` has placeholders only. If a secret is exposed, rotate it with the procedures below.

## 2. Rotating `JWT_KEYS` without closing sessions

Access tokens (8 hours, `JWT_ACCESS_TTL_SECONDS`) are signed with the **first** key of `JWT_KEYS` and verified with the key whose
`kid` they carry, so several keys can coexist (D-36, `src/security/tokens.ts`). Refresh tokens are opaque and do not use these
keys. The session lasts at most 12 hours (`SESSION_MAX_SECONDS`).

1. Generate a new key and choose a new `kid` (1 to 32 letters, digits, `.`, `_` or `-`, not used before):

   ```bash
   openssl rand -base64 32
   ```

   `env.ts` requires at least 32 bytes once decoded and refuses a repeated `kid`.
2. In the environment of `tech-docs-api`, put the **new key first** and keep the old one second:
   `JWT_KEYS` = `<new kid>:<new key>,<old kid>:<old key>`. Save, rebuild, and deploy.
3. From now on new tokens are signed with the new key, and the tokens already issued still verify with the old one. Nobody is
   signed out. Check that you can sign in.
4. After **12 hours** (longer than the 8-hour token and than the 12-hour session), remove the old key: `JWT_KEYS` =
   `<new kid>:<new key>`. Save, rebuild, and deploy. Tokens signed with the old key, if any remain, are refused and the client
   renews the session.
5. Record the new value in the password manager.

If a key leaked, skip the waiting: remove the old key at once; every user must sign in again.

## 3. Rotating the Jira webhook secret

1. Generate a random value, for example `openssl rand -base64 32`.
2. Update **both places together**: `JIRA_WEBHOOK_SECRET` in Render (Save, rebuild, and deploy) and the **Secret** field of the
   webhook "Documentación técnica – producción" in Jira (⚙️ → System → Advanced → WebHooks, edit the webhook). Deliveries sent
   between the two changes are refused with 401, so do them one right after the other.
3. Verify:
   - change the status of a ticket in Jira and check in its delivery log that the delivery is **204**;
   - send a delivery with an invalid signature: it must answer **401** `INVALID_SIGNATURE` (how it was sent on 2026-11-19, case
     MJ-06: not recorded).
4. Record the new value in the password manager.

## 4. Renewing the Jira token

The API token of the technical account expires. **Renew it before 2027-11-07.** With an expired token Jira answers 401 and the
API treats Jira as unavailable (D-89); the rest of the system keeps working.

1. In Atlassian, create a new API token for the technical account (labels of the Atlassian screens: not recorded).
2. Replace `JIRA_API_TOKEN` in the environment of `tech-docs-api`: Save, rebuild, and deploy.
3. Check that the Jira indicator of the application shows connected and that a ticket can be created (case MJ-01).
4. Revoke the old token in Atlassian and record the new one in the password manager.
5. Note the new expiry date here and in the calendar of the operator.

## 5. Rotating the passwords of the database roles

Use the external URL of the default user and the allowed IP (see [DEPLOYMENT.md](DEPLOYMENT.md) section 10).

```bash
read -rs -p 'Password of the default user: ' PGPASSWORD; export PGPASSWORD; echo
read -rs -p 'New password for docs_app: ' APP_PWD; echo
psql "<external connection URL of the default user>" -v app_pwd="$APP_PWD" <<'SQL'
ALTER ROLE docs_app PASSWORD :'app_pwd';
SQL
unset PGPASSWORD APP_PWD
```

- **`docs_app`:** after `ALTER ROLE`, update the password inside `APP_DATABASE_URL` in Render (Save, rebuild, and deploy). Until
  then the API cannot connect. Keep the user name `docs_app` in the URL (incident 3). Verify by connecting as `docs_app` and then
  by signing in to the application.
- **`docs_owner`:** the same `ALTER ROLE docs_owner PASSWORD :'owner_pwd'` with its own variable. Nothing is updated in Render: its
  URL is only in the operator's password manager. Verify by connecting as `docs_owner` before the next migration.
- The default user of the database is changed in the Render dashboard, not with this statement (procedure: not recorded).

## 6. Direct actions on the database

There is no operation in the API for these two cases. They are done as `docs_app` (never as `docs_owner` or the default user), so
the audit triggers record them with an empty actor and the database role `docs_app`. Do not disable triggers and do not write to
`audit_log`. Use them only when the application cannot do the task, and add a row to the log of section 6.3.

### 6.1 Recovering the access of the initial administrator

Use when the initial administrator cannot sign in and there is no other active Administrator who can change the password from
the application (an Administrator changes passwords from the user page). The password hash is replaced in `app_user`.

1. Generate the bcrypt hash of the new password (12 to 128 characters, letters and digits; cost 12 as in `BCRYPT_COST`) from the
   repository folder. The password is read from the terminal and the hash is the only thing that goes to the database:

   ```bash
   read -rs -p 'New password: ' NEW_PWD; export NEW_PWD; echo
   HASH=$(node -e "import('bcryptjs').then(({ hashSync }) => console.log(hashSync(process.env.NEW_PWD, 12)))")
   unset NEW_PWD
   ```

2. Connect as `docs_app` with the external URL built with `read -rs` and update only that user:

   ```bash
   psql "<docs_app external URL with ?sslmode=require>" -v hash="$HASH" -v email='<administrator e-mail>' <<'SQL'
   UPDATE app_user SET password_hash = :'hash' WHERE email = :'email' RETURNING id, email, status;
   SQL
   unset HASH
   ```

   The statement must return exactly one row (`UPDATE 1`). `email` is unique, so it cannot touch another user.
3. Sign in with the new password. Check in the audit page that the change is there.

The exact commands used on 2026-11-19 are not recorded. This procedure was written from the same method (the hash of the
administrator was replaced connecting as `docs_app`); the password is never passed on a command line. Whether sessions already open
are closed by a hash replaced this way: not recorded. Changing a password from the application closes them (SDD §11).

### 6.2 Exceptional deletion of a report

The contract has no operation to delete a report (a pending item of the product, D-157). A test report can be deleted by its id
and its title together, so that a wrong id cannot delete another report. The file of the report (`report_file`) is deleted with it
(`ON DELETE CASCADE`).

```bash
psql "<docs_app external URL with ?sslmode=require>" -v id=<report id> -v title='<exact title>' <<'SQL'
SELECT id, title, status, is_published FROM report WHERE id = :id AND title = :'title';
SQL
```

Check that exactly one row came back and that it is the report you mean. Then:

```bash
psql "<docs_app external URL with ?sslmode=require>" -v id=<report id> -v title='<exact title>' <<'SQL'
DELETE FROM report WHERE id = :id AND title = :'title' RETURNING id, title;
SQL
```

The exact statement used on 2026-11-20 is not recorded. A published report is visible to the Reader role: delete only reports that
were created for tests.

### 6.3 Log of direct actions

| Date | Action | Role | Recorded in the audit |
| ---- | ------ | ---- | --------------------- |
| 2026-11-19 | Replacement of the password hash of the initial administrator, after the passwords set by the first attempt were not the intended ones (incident 4) | `docs_app` | Yes, with an empty actor and the role `docs_app` |
| 2026-11-20 | Deletion of a test report (id and title: not recorded) | `docs_app` | Yes, with an empty actor and the role `docs_app` |

## 7. Users and applications

- **Create a user** from the user page of the application (Administrator). Use the **Generate** button for the initial password
  and give it to the person by a safe channel. Do not write it anywhere else.
- **Deactivate, do not delete.** A deactivated user cannot sign in and their previous actions stay in the audit. The reserved
  account "Integración Jira" must stay (the API refuses to start without `INTEGRATION_USER_EMAIL`).
- **Always keep one active Administrator.** Before deactivating or changing the role of an Administrator, check that another one is
  active.
- **Changing a password is done by an Administrator** (`PUT /users/{id}`). A user cannot change their own password yet (pending
  item, D-157).
- **Archive applications, do not delete.** An application with reports cannot be deleted (`RESTRICT`), and an archived application
  keeps its documentation read-only.

## 8. Dependencies and the audit gate

`npm run audit:gate` is the blocking audit of the CI: it fails on any `high` or `critical` advisory, development dependencies
included, except for the advisories in `EXCEPTIONS` of `scripts/auditGate.ts`. Exit code 0: no blocking advisory; 1: blocking
advisories; 2: `npm audit` gave no usable report (the gate fails closed). `--strict` ignores the exceptions (D-151).

Rules for an exception:

- It needs the approval of the author of the project, a written reason and a review date.
- It exists only when no patched version can be reached.
- It is removed when `npm audit` stops reporting it (the gate says "matches nothing now") and the gate warns when the review date
  has passed.

Current exception: `effect` (GHSA-7589-6fvf-x4pw), through `prisma` > `@prisma/config` > `effect` 3.20.0. Only the Prisma CLI
loads it. **Review by 2026-12-31** (D-156). It is removed when a release of `@prisma/config` asks for `effect` above 3.22.0; if the
date arrives without that, the author decides whether to renew it.

New dependencies: exact versions (`npm i -E`), the reason in the commit, and none that duplicates an existing one
(`CLAUDE.md` section 2). After a change, deploy as in [DEPLOYMENT.md](DEPLOYMENT.md) section 7.

## 9. New migrations

- **Never edit an applied migration.** Any change of the model is a new migration (`npx prisma migrate dev --create-only --name
  <name>`), followed by `npm run db:drift`, which must say "No difference detected" (rule 1 of `CLAUDE.md`).
- In production, migrations are applied as `docs_owner` from the operator's computer **before** the new version of the API is
  deployed ([DEPLOYMENT.md](DEPLOYMENT.md) section 7, and section 2 of [OPERATIONS_NOTES.md](../phase4/OPERATIONS_NOTES.md)).
- Check `_prisma_migrations` afterwards: every row finished. Production has 8 migrations at the time of writing.

## 10. Known limits

| Limit | What to know |
| ----- | ------------ |
| One instance | The rate limits, the report memory limits and the Epic exclusion live in the process (D-60, D-93). Do not scale the API to several instances before a shared store exists (D-155) |
| 512 MB of memory | Plan Starter. `REPORT_MAX_MEMORY_MB=192` limits the memory of the thread that writes a report, so a large report fails (`FAILED`, "too large") instead of taking the API down. If large reports fail or the service restarts for lack of memory, move to the 2 GB plan and raise `REPORT_MAX_MEMORY_MB` (accepted range 64 to 4096). Price of the 2 GB plan: not recorded |
| 5 GB of transfer | Included in the Hobby plan of the workspace. What happens beyond it: not recorded |
| Database of 256 MB (0.1 CPU) and 1 GB of storage | Watch the storage of `tech-docs-db` in Render as the audit and the documentation grow. Procedure to enlarge it: not recorded |
| Jira | If Jira fails, the circuit breaker opens for 60 s and the rest of the system keeps working (D-89) |

## 11. Logs and diagnosis

- **Render → `tech-docs-api` → Logs** shows the output of the API. Logs do not contain tokens, cookies, passwords or hashes.
- If the API does not start, the log lists each invalid or missing variable by **name** (`ConfigError`), never its value. The usual
  causes are in [DEPLOYMENT.md](DEPLOYMENT.md) section 3 and in the incidents of [DEFECTS.md](../phase4/DEFECTS.md).
- Error 42501 (insufficient privilege): the API is not connected as `docs_app`.
- Build exit code 127 or a failed `prisma generate`: check the Build Command and the filler `DATABASE_URL`.
- Jira shown as unavailable: check `JIRA_*` and the expiry of the token (section 4), then the logs of the Jira client (operation,
  attempt, reason and duration).
- Notifications of deploy failures and service down are on ([DEPLOYMENT.md](DEPLOYMENT.md) section 11).
