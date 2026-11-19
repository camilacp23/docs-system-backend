-- =====================================================================
-- Bootstrap for a database that ALREADY EXISTS and is run by a managed service (for example Render Postgres 18), where
-- the default user is NOT a superuser. Run it ONCE per environment, BEFORE the first `prisma migrate deploy`, as that
-- default user (it must own the database and have CREATEROLE). It does the same as 01_roles_and_database.sql except
-- that it does not create or connect to a database: it works on the one it is connected to (current_database()).
--
-- What it does:
--   1. Creates docs_owner and docs_app if they do not exist. Passwords come in as psql variables (never written here).
--   2. Applies to the current database the permissions of 01: REVOKE of PUBLIC, CONNECT and TEMPORARY for docs_app,
--      owner of the public schema = docs_owner, and nobody else (PUBLIC) can create in it.
--   3. Gives docs_owner CONNECT and CREATE on the database. In 01 docs_owner owns the database, so it needs no grant;
--      here the database belongs to the default user, and after REVOKE ... FROM PUBLIC docs_owner could not connect.
--      CREATE is needed because the first migration starts with `CREATE SCHEMA IF NOT EXISTS "public"`, which
--      PostgreSQL authorizes (CREATE on the database) before it sees that the schema already exists.
--   4. PostgreSQL 16+: a role with CREATEROLE that is not a superuser gets ADMIN OPTION on the roles it creates, but
--      without SET, and ALTER SCHEMA ... OWNER TO needs the SET option on the new owner. So the script grants itself
--      membership of docs_owner WITH SET TRUE, changes the owner of the schema, and revokes that membership again.
--
-- Usage (the connection password goes in PGPASSWORD, not in the command line; the URL is the EXTERNAL one of the service):
--   PGPASSWORD='<password of the default user>' psql "<external connection URL of the default user>" \
--        -v owner_pwd='<password for docs_owner>' -v app_pwd='<password for docs_app>' \
--        -f bootstrap/02_managed_database.sql
--
-- It can be run again: the roles are not created twice, and the grants and the owner are the same.
-- If docs_owner or docs_app already existed and were created by someone else, the default user needs ADMIN OPTION on
-- docs_owner (or to be a superuser) for step 4; otherwise PostgreSQL stops the script with a permission error.
-- =====================================================================
\set ON_ERROR_STOP on

SELECT current_setting('server_version_num')::int < 160000 AS too_old \gset
\if :too_old
  \echo 'This script needs PostgreSQL 16 or later (GRANT ... WITH SET).'
  \quit
\endif

SELECT current_database() AS db_name, rolsuper AS is_superuser
  FROM pg_roles WHERE rolname = current_user \gset

SELECT format('CREATE ROLE docs_owner LOGIN PASSWORD %L', :'owner_pwd')
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'docs_owner') \gexec
SELECT format('CREATE ROLE docs_app LOGIN NOINHERIT PASSWORD %L', :'app_pwd')
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'docs_app') \gexec

REVOKE ALL ON DATABASE :"db_name" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"db_name" TO docs_app;
GRANT CONNECT, CREATE ON DATABASE :"db_name" TO docs_owner;

-- A superuser can change the owner without being a member; anyone else needs the SET option for a moment.
\if :is_superuser
\else
  GRANT docs_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE;
\endif
ALTER SCHEMA public OWNER TO docs_owner;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
\if :is_superuser
\else
  REVOKE docs_owner FROM CURRENT_USER;
\endif

\echo 'Bootstrap done for the database' :db_name
