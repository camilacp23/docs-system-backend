/**
 * `npm run sandbox:db`: recreates the isolated database `docs_sandbox` from `docs_test_template`, seeds it and writes
 * the generated administrator credentials to the git-ignored file of the Bruno collection.
 * `--drop` only deletes it (used by `npm run test:api`). Never touches `docs_system`; never prints the password.
 */
import { dropSandbox, recreateSandbox, SANDBOX_ADMIN_EMAIL, SANDBOX_DB, SANDBOX_ENV_FILE } from './lib/sandbox.js';

if (process.argv.includes('--drop')) {
  await dropSandbox();
  console.log(`${SANDBOX_DB}: dropped`);
} else {
  await recreateSandbox();
  console.log(`${SANDBOX_DB}: recreated and seeded (administrator ${SANDBOX_ADMIN_EMAIL})`);
  console.log(`Credentials written to ${SANDBOX_ENV_FILE} (git-ignored)`);
}
