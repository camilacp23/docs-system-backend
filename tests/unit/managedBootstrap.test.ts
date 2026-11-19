/**
 * `bootstrap/02_managed_database.sql` (a database that already exists, run by a non-superuser with CREATEROLE): it works on
 * the current database, takes the passwords as psql variables and never writes one in the file, and keeps the grants of
 * `01_roles_and_database.sql`. A static test: the real run is the simulation described in `docs/phase4/OPERATIONS_NOTES.md`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const sql = readFileSync(new URL('../../bootstrap/02_managed_database.sql', import.meta.url), 'utf8');
/** The statements, without the comment lines. */
const code = sql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('bootstrap/02_managed_database.sql', () => {
  it('works on the current database: no fixed name, no connect and no CREATE DATABASE', () => {
    assert.match(code, /current_database\(\)/);
    assert.doesNotMatch(code, /\connect|CREATE DATABASE|docs_system|docs_shadow/i);
  });

  it('takes both passwords as psql variables and writes none', () => {
    assert.match(code, /PASSWORD %L', :'owner_pwd'/);
    assert.match(code, /PASSWORD %L', :'app_pwd'/);
    assert.doesNotMatch(code, /PASSWORD\s+'/i);
  });

  it('creates the roles only when they do not exist, like script 01', () => {
    assert.match(code, /CREATE ROLE docs_owner LOGIN PASSWORD/);
    assert.match(code, /CREATE ROLE docs_app LOGIN NOINHERIT PASSWORD/);
    assert.equal((code.match(/WHERE NOT EXISTS \(SELECT FROM pg_roles/g) ?? []).length, 2);
  });

  it('keeps the grants of script 01 and adds what a non-owner docs_owner needs', () => {
    assert.match(code, /REVOKE ALL ON DATABASE :"db_name" FROM PUBLIC;/);
    assert.match(code, /GRANT CONNECT, TEMPORARY ON DATABASE :"db_name" TO docs_app;/);
    assert.match(code, /GRANT CONNECT, CREATE ON DATABASE :"db_name" TO docs_owner;/);
    assert.match(code, /ALTER SCHEMA public OWNER TO docs_owner;/);
    assert.match(code, /REVOKE CREATE ON SCHEMA public FROM PUBLIC;/);
  });

  it('gives itself SET on docs_owner only for the change of owner, then revokes it (PostgreSQL 16+)', () => {
    const grant = code.indexOf('GRANT docs_owner TO CURRENT_USER WITH SET TRUE');
    const alter = code.indexOf('ALTER SCHEMA public OWNER TO docs_owner');
    const revoke = code.indexOf('REVOKE docs_owner FROM CURRENT_USER');
    assert.ok(grant > 0 && grant < alter && alter < revoke);
    assert.match(code, /server_version_num'\)::int < 160000/);
  });
});
