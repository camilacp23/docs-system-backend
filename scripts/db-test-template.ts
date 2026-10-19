/** `npm run db:test:template`: builds or refreshes the `docs_test_template` database used by the tests. */
import { ensureTemplate, TEMPLATE_NAME } from '../tests/helpers/testDb.js';

const { reused } = await ensureTemplate();
console.log(reused ? `${TEMPLATE_NAME}: up to date (reused)` : `${TEMPLATE_NAME}: rebuilt from prisma/migrations`);
