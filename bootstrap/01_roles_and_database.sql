-- =====================================================================
-- Bootstrap (run ONCE per environment, by a PostgreSQL superuser/DBA,
-- BEFORE the first `prisma migrate deploy`). Not a Prisma migration:
-- roles are cluster-wide and passwords must not live in Git.
-- Usage:
--   psql -h <host> -U postgres -v owner_pwd='***' -v app_pwd='***' \
--        -v db_name=docs_system -f bootstrap/01_roles_and_database.sql
-- =====================================================================
\set ON_ERROR_STOP on

SELECT format('CREATE ROLE docs_owner LOGIN PASSWORD %L', :'owner_pwd')
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'docs_owner') \gexec
SELECT format('CREATE ROLE docs_app LOGIN NOINHERIT PASSWORD %L', :'app_pwd')
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'docs_app') \gexec

SELECT format('CREATE DATABASE %I OWNER docs_owner', :'db_name')
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'db_name') \gexec

\connect :db_name
REVOKE ALL ON DATABASE :"db_name" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"db_name" TO docs_app;
ALTER SCHEMA public OWNER TO docs_owner;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Development only: `prisma migrate dev` needs to create a shadow database.
-- In production only `prisma migrate deploy` is used (no shadow database).
-- ALTER ROLE docs_owner CREATEDB;
