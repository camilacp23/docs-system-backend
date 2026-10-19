/**
 * `npm run db:seed`: creates the first administrator and the reserved account "Integración Jira" (idempotent).
 * Connects as docs_app (APP_DATABASE_URL). Never prints passwords or hashes.
 *
 * @module scripts/seed
 */
import '../config/loadEnvFile.js';
import { ConfigError } from '../config/index.js';
import { loadSeedConfig, type SeedConfig } from '../config/seed.js';
import { createPrisma } from '../db/prisma.js';
import { runSeed, SeedError } from '../db/seed.js';

async function main(): Promise<number> {
  let config: SeedConfig;
  try {
    config = loadSeedConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }

  const db = createPrisma(config.appDatabaseUrl);
  try {
    const result = await runSeed(db, config);
    console.log(
      result.admin === 'created'
        ? `Administrator ${config.adminEmail}: created`
        : `Administrator ${config.adminEmail}: already exists, not modified`,
    );
    console.log(
      result.reserved === 'created'
        ? `Reserved account ${config.integrationUserEmail}: created (READER, INACTIVE)`
        : `Reserved account ${config.integrationUserEmail}: already exists, not modified`,
    );
    console.log('Remember to remove SEED_ADMIN_PASSWORD from .env now.');
    return 0;
  } catch (e) {
    if (e instanceof SeedError) console.error(e.message);
    else console.error(`Seed failed: ${e instanceof Error ? e.name : 'unknown error'}`);
    return 1;
  } finally {
    await db.base.$disconnect();
  }
}

process.exitCode = await main();
