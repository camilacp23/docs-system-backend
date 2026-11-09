/**
 * Contract against the migrated database for the audit values that are CHECK constraints, not enumerated types, so
 * `api/check_contract_vs_db.py` (which compares enumerated types and lengths) does not cover them: the table names of
 * `audit_log.entity_type` and the actions of `audit_log.action` must be exactly the values the contract declares
 * (`AuditEntityType` and the `action` of the audit schemas and parameter).
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { parse } from 'yaml';
import { DEFAULT_OPENAPI_PATH } from '../../src/app.js';
import { createTestDb, type TestDb } from '../helpers/testDb.js';

type Schema = { enum?: string[]; properties?: Record<string, Schema> };
type Contract = {
  paths: Record<string, { get: { parameters: { name?: string; schema?: Schema }[] } }>;
  components: { schemas: Record<string, Schema> };
};

const contract = parse(readFileSync(DEFAULT_OPENAPI_PATH, 'utf8')) as Contract;
const sorted = (values: readonly string[]) => [...values].sort();

/** The quoted literals of a CHECK definition such as `CHECK ((action = ANY (ARRAY['CREATE'::text, ...])))`. */
const literalsOf = (definition: string) => [...definition.matchAll(/'([^']+)'/g)].map((m) => m[1]!);

describe('audit_log CHECK values match the contract', () => {
  let db: TestDb;
  let owner: pg.Client;

  before(async () => {
    db = await createTestDb();
    owner = new pg.Client({ connectionString: db.ownerUrl });
    await owner.connect();
  });
  after(async () => {
    await owner.end();
    await db.drop();
  });

  /** Definition of the CHECK that constrains one column of audit_log, read from the catalog. */
  async function checkOf(column: string): Promise<string> {
    const res = await owner.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS definition
         FROM pg_constraint c
        WHERE c.conrelid = 'public.audit_log'::regclass
          AND c.contype = 'c'
          AND c.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a
                                 WHERE a.attrelid = c.conrelid AND a.attname = $1)]`,
      [column],
    );
    assert.equal(res.rowCount, 1, `audit_log.${column} must have exactly one single-column CHECK`);
    return res.rows[0]!.definition;
  }

  it('entity_type is exactly AuditEntityType', async () => {
    const inDb = literalsOf(await checkOf('entity_type'));
    const inContract = contract.components.schemas.AuditEntityType?.enum ?? [];
    assert.ok(inDb.length > 0 && inContract.length > 0);
    assert.deepEqual(sorted(inContract), sorted(inDb));
  });

  it('action is exactly the action of AuditEntry, ActivitySummary and the GET /audit-log filter', async () => {
    const inDb = literalsOf(await checkOf('action'));
    const filter = contract.paths['/audit-log']?.get.parameters.find((p) => p.name === 'action')?.schema?.enum;
    const declared: Record<string, string[] | undefined> = {
      'AuditEntry.action': contract.components.schemas.AuditEntry?.properties?.action?.enum,
      'ActivitySummary.action': contract.components.schemas.ActivitySummary?.properties?.action?.enum,
      'GET /audit-log action': filter,
    };
    assert.ok(inDb.length > 0);
    for (const [where, values] of Object.entries(declared)) {
      assert.ok(values, `${where} must be an enumeration`);
      assert.deepEqual(sorted(values), sorted(inDb), where);
    }
  });
});
