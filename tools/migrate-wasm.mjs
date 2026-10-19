// Sandbox substitute for `prisma migrate deploy` / `prisma migrate diff`.
// Uses Prisma's own schema engine (@prisma/schema-engine-wasm 7.10.0) through
// the official PostgreSQL driver adapter. In a normal environment use the CLI.
//   node tools/migrate-wasm.mjs deploy          -> apply pending migrations
//   node tools/migrate-wasm.mjs drift           -> diff migrations vs schema.prisma (expects empty)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url); // optional tool: npm i --no-save @prisma/schema-engine-wasm@7.10.0-4.0edf323efd1d98336f3f0a68684b56f689b900d3 @prisma/driver-adapter-utils@7.10.0
const { SchemaEngine } = await import(require.resolve('@prisma/schema-engine-wasm'));
const { PrismaPg } = await import(require.resolve('@prisma/adapter-pg'));
const { bindMigrationAwareSqlAdapterFactory } = await import(require.resolve('@prisma/driver-adapter-utils'));

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const schemaPath = path.join(root, 'prisma/schema.prisma');
const migDir = path.join(root, 'prisma/migrations');
const schema = fs.readFileSync(schemaPath, 'utf8');
const list = {
  baseDir: migDir,
  lockfile: { path: 'migration_lock.toml', content: fs.readFileSync(path.join(migDir, 'migration_lock.toml'), 'utf8') },
  shadowDbInitScript: '',
  migrationDirectories: fs.readdirSync(migDir).filter((d) => fs.statSync(path.join(migDir, d)).isDirectory()).sort()
    .map((d) => ({ path: d, migrationFile: { path: 'migration.sql', content: { tag: 'ok', value: fs.readFileSync(path.join(migDir, d, 'migration.sql'), 'utf8') } } })),
};
const filters = { externalTables: [], externalEnums: [] };
// adapter-pg 7.10.0 splits scripts on every ';' (breaks PL/pgSQL bodies). The native
// schema engine used by the CLI sends each migration whole; replicate that here.
// Pass discrete fields (not connectionString): adapter-pg builds the shadow DB config by
// overriding `database`, which node-postgres ignores when a connectionString is present.
const u = new URL(process.env.DATABASE_URL);
const pg = new PrismaPg({ host: u.hostname, port: Number(u.port || 5432), user: decodeURIComponent(u.username),
  password: decodeURIComponent(u.password), database: u.pathname.slice(1) });
const wholeScript = (a) => { a.executeScript = async (sql) => { try { await a.client.query(sql); } catch (e) { a.onError(e); } }; return a; };
const connect = pg.connect.bind(pg);
pg.connect = async () => wholeScript(await connect());
// adapter-pg 7.10.0 drops the shadow DB before closing its pool ("being accessed by other users").
// Same steps, correct order: close the shadow pool first, then drop the database.
pg.connectToShadowDb = async () => {
  const main = await connect();
  const name = `prisma_migrate_shadow_db_${globalThis.crypto.randomUUID()}`;
  await main.client.query(`CREATE DATABASE "${name}"`);
  const shadow = wholeScript(await new PrismaPg({ ...pg.config, database: name }).connect());
  const release = shadow.dispose.bind(shadow);
  shadow.dispose = async () => { await release(); await main.client.query(`DROP DATABASE "${name}"`); await main.dispose(); };
  return shadow;
};
const adapter = bindMigrationAwareSqlAdapterFactory(pg);
const eng = await SchemaEngine.new({ datamodels: [['schema.prisma', schema]] }, () => {}, adapter);
const cmd = process.argv[2];
if (cmd === 'deploy') {
  const out = await eng.applyMigrations({ migrationsList: list, filters });
  console.log('Applied:', out.appliedMigrationNames.length ? out.appliedMigrationNames.join(', ') : '(none pending)');
} else if (cmd === 'drift') {
  const r = await eng.diff({ from: { tag: 'migrations', ...list }, to: { tag: 'schemaDatamodel', files: [{ path: 'schema.prisma', content: schema }] }, script: true, exitCode: true, filters });
  console.log(r.exitCode === 0 ? 'NO DRIFT: migrations == schema.prisma' : 'DRIFT (exit ' + r.exitCode + '):\n' + r.stdout);
}
process.exit(0);
