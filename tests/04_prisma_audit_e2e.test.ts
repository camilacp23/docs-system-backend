/**
 * End-to-end test: Prisma Client 7.10.0 (as the API role docs_app) +
 * audit triggers. Run on a disposable copy of the migrated database:
 *   APP_URL=postgresql://docs_app:***@localhost:5432/<copy> \
 *   ADMIN_URL=postgresql://<superuser>:***@localhost:5432/<copy> \
 *   npx tsx tests/04_prisma_audit_e2e.test.ts
 */
import pg from 'pg';
import { auditContext, createPrisma } from '../src/db/prisma.js';

const { prisma, auditedTransaction, base } = createPrisma(process.env.APP_URL!);
const admin = new pg.Client({ connectionString: process.env.ADMIN_URL });
let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' ' + detail : ''}`);
};
const audit = async (where: string) => (await admin.query(`SELECT * FROM audit_log WHERE ${where} ORDER BY id`)).rows;

async function main() {
  await admin.connect();

  // Bootstrap: first administrator (no authenticated user yet -> no context)
  const u1 = await prisma.user.create({ data: { name: 'Admin', email: 'admin@dept.local', passwordHash: 'h', role: 'ADMINISTRATOR' } });
  // Rule R-1: always AWAIT inside auditContext.run (Prisma queries are lazy; see E11)
  const u2 = await auditContext.run({ userId: u1.id }, async () =>
    await prisma.user.create({ data: { name: 'Dev', email: 'dev@dept.local', passwordHash: 'h', role: 'DEVELOPER' } }));

  await auditContext.run({ userId: u1.id }, async () => {
    const app = await prisma.application.create({ data: { name: 'SAR', platform: 'Power Apps', createdById: u1.id } });

    // E01 nested write: supertype + subtype in one call (composite FK filled by Prisma)
    const el = await prisma.documentedElement.create({
      data: { type: 'SCREEN', applicationId: app.id,
        screen: { create: { name: 'Solicitudes', authorId: u1.id } } },
      include: { screen: true },
    });
    check('E01 nested create supertype + screen (composite FK, deferred subtype check)',
      el.screen?.elementType === 'SCREEN' && el.screen?.applicationId === app.id);

    // E02 variable + environments in the same nested write (deferred environment check)
    const v = await prisma.documentedElement.create({
      data: { type: 'VARIABLE', applicationId: app.id,
        variable: { create: { name: 'gFiltro', dataType: 'TEXT', scope: 'GLOBAL', originScreenId: el.id } },
        environments: { create: [{ environment: 'DEV' }, { environment: 'PROD' }] } },
    });
    check('E02 nested create variable + environments', !!v.id);

    const rows = await audit(`entity_type = 'screen' AND entity_id = '${el.id}' AND action = 'CREATE'`);
    check('E03 extension set the actor for a nested write', rows.length === 1 && rows[0].actor_user_id === u1.id && rows[0].db_role === 'docs_app',
      `(actor=${rows[0]?.actor_user_id}, db_role=${rows[0]?.db_role})`);
    const origin = await audit(`entity_type = 'screen_variable' AND entity_label = 'origin'`);
    check('E04 trigger-generated origin link audited with the same actor', origin.length === 1 && origin[0].actor_user_id === u1.id);

    // E05 updateMany: exact old/new values per row, which a Prisma-only audit could not provide
    await prisma.screen.updateMany({ where: { applicationId: app.id }, data: { documentationStatus: 'DRAFT' } });
    const upd = await audit(`entity_type = 'screen' AND action = 'UPDATE' AND 'documentation_status' = ANY(changed_fields)`);
    check('E05 updateMany audited row by row with old/new values', upd.length === 2 &&
      upd.every((r) => r.actor_user_id === u1.id && r.old_value.documentation_status === 'UNDOCUMENTED'), `(${upd.length} rows)`);

    // E06 multi-step + raw SQL + business event inside auditedTransaction
    await auditedTransaction(async (tx) => {
      await tx.$executeRaw`UPDATE screen SET documentation_status = 'APPROVED' WHERE id = ${el.id}`;
      await tx.$queryRaw`SELECT log_business_event('DOCUMENTATION_APPROVED', 'screen', ${String(el.id)}, 'Solicitudes', NULL::jsonb, ${app.id})`;
    });
    const raw = await audit(`entity_type = 'screen' AND entity_id = '${el.id}' AND new_value->>'documentation_status' = 'APPROVED'`);
    const ev = await audit(`action = 'EVENT' AND event_name = 'DOCUMENTATION_APPROVED'`);
    check('E06 raw SQL write in auditedTransaction audited with actor', raw.length === 1 && raw[0].actor_user_id === u1.id);
    check('E07 business event recorded in the same transaction', ev.length === 1 && ev[0].actor_user_id === u1.id);
  });

  // E08 concurrent requests from two users do not mix actors (ALS + transaction-local setting)
  const screens = await base.screen.findMany({ where: { isAppContext: false } });
  const s = screens[0];
  await Promise.all(Array.from({ length: 20 }, (_, i) => {
    const uid = i % 2 === 0 ? u1.id : u2.id;
    return auditContext.run({ userId: uid }, async () =>
      await prisma.screen.update({ where: { id: s.id }, data: { risks: `risk by ${uid} #${i}` } }));
  }));
  const conc = await audit(`entity_type = 'screen' AND 'risks' = ANY(changed_fields)`);
  const mixed = conc.filter((r) => !String(r.new_value.risks).startsWith(`risk by ${r.actor_user_id} `));
  check('E08 20 concurrent writes by 2 users: every record has its own actor', conc.length === 20 && mixed.length === 0,
    `(${conc.length} records, ${mixed.length} mismatched)`);

  // E09 write outside any request context: actor NULL, db_role still identifies the API
  await prisma.screen.update({ where: { id: s.id }, data: { knownIssues: 'job nocturno' } });
  const noCtx = await audit(`entity_type = 'screen' AND 'known_issues' = ANY(changed_fields)`);
  check('E09 write without context: actor NULL, db_role = docs_app', noCtx.length === 1 && noCtx[0].actor_user_id === null && noCtx[0].db_role === 'docs_app');

  // E11 documents the pitfall behind rule R-1: a Prisma query is a LAZY promise. Returned
  // un-awaited from auditContext.run, it executes later, outside the context -> no actor.
  const lazy = auditContext.run({ userId: u1.id }, () =>
    prisma.screen.update({ where: { id: s.id }, data: { requirements: 'lazy' } }));
  await lazy;
  const lz = await audit(`entity_type = 'screen' AND 'requirements' = ANY(changed_fields)`);
  check('E11 (pitfall, rule R-1) un-awaited query escapes the context: actor NULL', lz.length === 1 && lz[0].actor_user_id === null);

  // E10 auditedTransaction refuses to run without an authenticated context
  let refused = false;
  try { await auditedTransaction(async () => 1); } catch { refused = true; }
  check('E10 auditedTransaction requires an audit context', refused);
}

main()
  .catch((e) => { failures++; console.error('FAIL  unexpected error:', e); })
  .finally(async () => {
    await prisma.$disconnect(); await admin.end();
    console.log(failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
  });
