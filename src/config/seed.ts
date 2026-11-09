/**
 * Configuration of `npm run db:seed` (decisions "Siembra", D-51, NFR-02, NFR-06).
 *
 * Only the variables the seed needs are required (the JWT keys, for example, are not). Every problem is reported
 * together, naming the variable but never its value, so a failed seed never prints the password.
 *
 * @module config/seed
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { ConfigError } from './env.js';

export type SeedConfig = {
  /** docs_app connection: the seed is audited like any other write of the API (NFR-20). */
  appDatabaseUrl: string;
  bcryptCost: number;
  adminName: string;
  /** Lowercase. */
  adminEmail: string;
  adminPassword: string;
  /** Lowercase e-mail of the reserved account "Integración Jira" (D-51). */
  integrationUserEmail: string;
};

const CONTRACT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'api', 'openapi.yaml');
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_NAME_LENGTH = 120; // app_user.name VARCHAR(120)
const MAX_EMAIL_LENGTH = 254; // app_user.email VARCHAR(254)

/**
 * Reads the `Password` pattern from the OpenAPI contract, the single source of the password policy (NFR-02).
 *
 * @param contractPath - Contract to read (default `api/openapi.yaml`).
 * @returns The compiled pattern.
 * @throws {Error} When the contract has no `components.schemas.Password.pattern`.
 */
export function loadPasswordPattern(contractPath = CONTRACT_PATH): RegExp {
  const contract = parse(readFileSync(contractPath, 'utf8')) as {
    components?: { schemas?: { Password?: { pattern?: string } } };
  };
  const pattern = contract.components?.schemas?.Password?.pattern;
  if (!pattern) throw new Error('The contract has no components.schemas.Password.pattern');
  return new RegExp(pattern);
}

/**
 * Reads and validates the seed variables.
 *
 * @param env - Variables to read (defaults to `process.env`).
 * @param passwordPattern - Password policy (defaults to the contract's).
 * @returns The typed seed configuration.
 * @throws {ConfigError} Listing every missing or invalid variable (never a value).
 */
export function loadSeedConfig(
  env: NodeJS.ProcessEnv = process.env,
  passwordPattern: RegExp = loadPasswordPattern(),
): SeedConfig {
  const problems: string[] = [];
  const read = (name: string): string | undefined => {
    const v = env[name]?.trim();
    if (v === undefined || v === '' || v.includes('CHANGE_ME')) {
      problems.push(`${name}: is required`);
      return undefined;
    }
    return v;
  };
  const email = (name: string): string | undefined => {
    const v = read(name);
    if (v === undefined) return undefined;
    if (!EMAIL_PATTERN.test(v) || v.length > MAX_EMAIL_LENGTH) {
      problems.push(`${name}: must be a valid e-mail address of at most ${MAX_EMAIL_LENGTH} characters`);
      return undefined;
    }
    return v.toLowerCase();
  };

  const appDatabaseUrl = read('APP_DATABASE_URL');
  const adminName = read('SEED_ADMIN_NAME');
  if (adminName !== undefined && adminName.length > MAX_NAME_LENGTH) {
    problems.push(`SEED_ADMIN_NAME: must be at most ${MAX_NAME_LENGTH} characters`);
  }
  const adminEmail = email('SEED_ADMIN_EMAIL');
  const integrationUserEmail = email('INTEGRATION_USER_EMAIL');

  // Not trimmed: spaces are legitimate password characters.
  const rawPassword = env.SEED_ADMIN_PASSWORD;
  let adminPassword: string | undefined;
  if (rawPassword === undefined || rawPassword === '' || rawPassword.includes('CHANGE_ME')) {
    problems.push('SEED_ADMIN_PASSWORD: is required');
  } else if (!passwordPattern.test(rawPassword)) {
    problems.push('SEED_ADMIN_PASSWORD: does not meet the password policy (12-128 characters with letters and digits)');
  } else {
    adminPassword = rawPassword;
  }

  const rawCost = env.BCRYPT_COST?.trim();
  let bcryptCost = 12;
  if (rawCost !== undefined && rawCost !== '') {
    if (/^\d+$/.test(rawCost) && Number(rawCost) >= 4 && Number(rawCost) <= 15) bcryptCost = Number(rawCost);
    else problems.push('BCRYPT_COST: must be an integer between 4 and 15');
  }

  if (adminEmail !== undefined && adminEmail === integrationUserEmail) {
    problems.push(
      'SEED_ADMIN_EMAIL: must differ from INTEGRATION_USER_EMAIL (the reserved account is not an administrator)',
    );
  }

  if (
    problems.length > 0 ||
    appDatabaseUrl === undefined ||
    adminName === undefined ||
    adminEmail === undefined ||
    adminPassword === undefined ||
    integrationUserEmail === undefined
  ) {
    throw new ConfigError(problems);
  }
  return { appDatabaseUrl, bcryptCost, adminName, adminEmail, adminPassword, integrationUserEmail };
}
