# CLAUDE.md — docs-system-backend

Backend of **"Documentación técnica"**, the technical documentation management system of the
Enterprise Architecture Department (SAR is the first documented application). Phase 3 (development)
of the project. The design (Phase 2) is complete, verified and frozen: build on it, never redo it.

## 1. Sources of truth (read before changing anything)

| Priority | Source | Path | Governs |
|---|---|---|---|
| 1 | SRS v1.3 | `docs/requirements/SRS_v1.3.md` | WHAT the system must do (FR-01..FR-27, NFR-01..NFR-20, roles Table 26, standards §3.7) |
| 2 | SDD v1.4 | `docs/design/SDD_v1.4.md` | HOW it is built (architecture §4, data §6, API conventions §7.1, errors Table 45, UI §7.3, workflow §9, security §11, decisions Table 70). It is the only SDD in `docs/design` (there is no `SDD_v1.2.md` and no `SDD_v1.5.md`); the SDD v1.6 will replace it in a later documentation branch. |
| 3 | OpenAPI 3.1 contract | `api/openapi.yaml` | The API. **Where an SDD table and the contract differ, the contract prevails** (SDD §7). Authorization is generated from its `x-roles` / `x-rule`. |
| 4 | Phase 3 decisions | `docs/phase3/DECISIONS_FASE3.md` | Decisions approved after SDD v1.0: D-60 to D-114 are incorporated in SDD v1.4, the later ones (D-115 on) are only here until the SDD v1.6. |
| 5 | Weekly plan | `docs/phase3/PLAN_SEMANA6.md` | Task scope (B-xx). |
| — | Phase 2 guides | `docs/guides/` | How the baseline was installed and verified. |

If two sources contradict each other, or something is not defined in them: **STOP and ask the
user. Never invent requirements, fields, codes, messages, limits or behavior.**

## 2. Stack (exact versions — pinned, no ranges)

Node.js ≥ 22.22 · Express 4.22.3 · PostgreSQL 18.3 · Prisma ORM 7.10.0 (`prisma`, `@prisma/client`,
`@prisma/adapter-pg`) · express-openapi-validator 5.6.2 · jsonwebtoken 9.0.3 · bcryptjs 3.0.3 ·
cookie-parser 1.4.7 · express-rate-limit 8.7.0 · helmet 8.3.0 · cors 2.8.6 · TypeScript 5.9.3 · tsx.
New dependencies: pin the exact latest stable version compatible with the above (`npm i -E`), state
why in the commit, and never add a dependency that duplicates an existing one.

## 3. Non-negotiable rules

1. **Migrations are immutable.** Never edit anything under `prisma/migrations/`. Any model change is a
   NEW migration (`npx prisma migrate dev --create-only --name <name>`, hand-edit if it contains
   CHECK/trigger/grant objects), followed by `npm run db:drift` = "No difference detected".
   Never touch `migration_lock.toml`. Files must keep LF line endings.
2. **Authorization comes only from the contract.** Every operation must exist in `api/openapi.yaml`
   with `x-roles` before it is coded; the server refuses to start otherwise (D-39). Routes never
   declare roles. Data rules (`x-rule`) are applied in services.
3. **Audit is in the database.** Never disable triggers or write to `audit_log`. Every write in an
   authenticated request is `await`ed inside the audit context (R-1); multi-step or raw SQL writes use
   `auditedTransaction()` (R-2). Business events only via `log_business_event()`.
4. **Runtime role.** The API connects as `docs_app` (`APP_DATABASE_URL`). `docs_owner`
   (`DATABASE_URL`) is only for the Prisma CLI (migrations).
5. **Layers (SDD §4.1, Table 6, D-42):** `src/modules/<module>/{routes,controller,service,repository}.ts`.
   Controllers do HTTP only; services hold rules and transactions and never see req/res; repositories
   hold Prisma queries only; a module uses another module only through its service.
6. **API conventions (SDD §7.1 Table 44):** base `/api/v1`; JSON camelCase; collection envelope
   `{ data, page, pageSize, total }`, single `{ data }`; errors `{ code, message, details }` with codes
   and English messages exactly from SDD Table 45/59 and `src/security/errors.ts`; pagination default
   20, max 100; ETag on every GET, If-Match → 412; POST 201 + Location; DELETE 204.
7. **Security (SDD §11):** access token only in Authorization header; refresh token only in the `rt`
   cookie (HttpOnly, Secure, SameSite=Strict, Path=/api/v1/auth); role and status read from the DB on
   every request; never log tokens, cookies, passwords or hashes; never return `passwordHash`.
8. **Secrets** only in `.env` (git-ignored). `.env.example` contains placeholders only (NFR-06).
9. **Phase 2 evidence is frozen:** do not modify `tests/01_…` to `tests/10_…`, `test-results/`,
   `src/security/testApp.ts` or `src/security/authService.ts` (test 07 depends on them). New tests go
   in `tests/unit/` and `tests/integration/`. The 153 legacy checks must stay green.
10. **Never run tests or destructive commands against `docs_system`.** Tests use disposable databases.
11. **Standards (SRS §3.7):** camelCase functions/variables, PascalCase types, UPPER_SNAKE_CASE
    constants, snake_case only in SQL; JSDoc on exported functions and modules.

## 4. Git

- Branches: `main` (stable) ← `develop` (integration) ← `feature/<name>`. Work only on the feature
  branch named in the prompt.
- Conventional Commits in English (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `ci:`),
  referencing FR-xx/NFR-xx when applicable. Small, coherent local commits are allowed.
- **Never `git push`, never open PRs, never rewrite history** — the user does that manually.

## 5. Environment

Windows 11 + Git Bash (write commands for bash). PostgreSQL 18.3 local. Superuser `postgres`.
Databases: `docs_system` (dev), `docs_shadow` (Prisma shadow). Roles created by
`bootstrap/01_roles_and_database.sql`.

## 6. Definition of done (every task)

`npm run lint` · `npm run typecheck` · `npm test` (new tests) · `npm run test:legacy` (153 checks,
once it exists) all green; contract changes validated with
`npx @redocly/cli@2.11.1 lint api/openapi.yaml --extends recommended` and
`npm run db:test:template` followed by
`python api/check_contract_vs_db.py api/openapi.yaml "-h localhost -U postgres -d docs_test_template"`;
a short report listing files changed, tests run with counts, and anything left open or assumed.
