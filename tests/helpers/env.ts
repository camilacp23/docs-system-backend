/**
 * Import FIRST in every test that loads the application: `src/security/config.ts` reads the environment when it is
 * imported, so these defaults must exist before. Real variables (from .env or the shell) are never overridden.
 */
import { randomBytes } from 'node:crypto';

process.env.INTEGRATION_USER_EMAIL ??= 'integracion.jira@system.local';
process.env.JWT_KEYS ??= `test:${randomBytes(32).toString('base64')}`;
process.env.FRONTEND_ORIGIN ??= 'http://localhost:5173';
