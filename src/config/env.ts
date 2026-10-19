/**
 * Startup configuration of the API (SDD Table 68, NFR-06).
 *
 * `loadConfig` reads every variable of `.env.example`, validates type, range and format, and returns one typed
 * object. All problems are reported together, naming the variable but never its value, so a failed start never
 * prints a secret. Jira variables are optional until the Jira module exists.
 *
 * @module config/env
 */

export type NodeEnv = 'development' | 'test' | 'production';
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

/** Signing key of the access tokens: `kid` goes in the JWT header, the first key of the list signs. */
export type JwtKey = { kid: string; secret: Buffer };

export type JiraConfig = {
  baseUrl?: string;
  email?: string;
  apiToken?: string;
  projectKey?: string;
  issueTypeEpicId?: string;
  issueTypeStoryId?: string;
  issueTypeSubtaskId?: string;
  webhookSecret?: string;
};

export type AppConfig = {
  nodeEnv: NodeEnv;
  port: number;
  logLevel: LogLevel;
  /** Value for Express "trust proxy". */
  trustProxy: boolean | number | string;
  /** docs_owner connection (Prisma CLI only). Optional for the API. */
  databaseUrl?: string;
  shadowDatabaseUrl?: string;
  /** docs_app connection (the API at runtime). */
  appDatabaseUrl: string;
  jwtKeys: JwtKey[];
  jwtAccessTtlSeconds: number;
  sessionMaxSeconds: number;
  bcryptCost: number;
  /** The only Origin accepted by CORS and by the cookie endpoints. */
  frontendOrigin: string;
  /** D-60 */
  rateLimitSessionMax: number;
  rateLimitSessionWindowMinutes: number;
  /** Lowercase e-mail of the reserved account "Integración Jira" (D-51). */
  integrationUserEmail: string;
  seed: { adminName?: string; adminEmail?: string };
  jira: JiraConfig;
};

/** Raised by `loadConfig`; `problems` has one line per invalid variable (never a value). */
export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

const LOG_LEVELS: readonly LogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];
const NODE_ENVS: readonly NodeEnv[] = ['development', 'test', 'production'];
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const KID_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const JIRA_KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,19}$/;
const MIN_KEY_BYTES = 32; // 256 bits (NFR-01)

/** True for the placeholders of `.env.example` ("CHANGE_ME", "<site>", empty). */
const isPlaceholder = (v: string | undefined): boolean => !v || v.includes('CHANGE_ME') || /<[^>]*>/.test(v);

/** Collects problems while reading variables, so every one is reported in a single start-up error. */
class Reader {
  readonly problems: string[] = [];

  constructor(private readonly env: NodeJS.ProcessEnv) {}

  raw(name: string): string | undefined {
    const v = this.env[name]?.trim();
    return v === undefined || v === '' ? undefined : v;
  }

  fail(name: string, why: string): void {
    this.problems.push(`${name}: ${why}`);
  }

  required(name: string): string | undefined {
    const v = this.raw(name);
    if (v === undefined) this.fail(name, 'is required');
    return v;
  }

  int(name: string, opts: { min: number; max: number; fallback: number }): number {
    const v = this.raw(name);
    if (v === undefined) return opts.fallback;
    if (!/^-?\d+$/.test(v) || Number(v) < opts.min || Number(v) > opts.max) {
      this.fail(name, `must be an integer between ${opts.min} and ${opts.max}`);
      return opts.fallback;
    }
    return Number(v);
  }

  oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
    const v = this.raw(name);
    if (v === undefined) return fallback;
    const found = allowed.find((a) => a === v);
    if (found === undefined) {
      this.fail(name, `must be one of: ${allowed.join(', ')}`);
      return fallback;
    }
    return found;
  }

  /** Parses a URL and checks its protocol; returns the original text. */
  url(name: string, protocols: readonly string[], value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    try {
      const parsed = new URL(value);
      if (!protocols.includes(parsed.protocol)) throw new Error('protocol');
      return value;
    } catch {
      this.fail(name, `must be a valid URL (${protocols.join(' or ')})`);
      return undefined;
    }
  }

  email(name: string, value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    if (!EMAIL_PATTERN.test(value)) {
      this.fail(name, 'must be a valid e-mail address');
      return undefined;
    }
    return value.toLowerCase();
  }
}

function parseTrustProxy(r: Reader): boolean | number | string {
  const v = r.raw('TRUST_PROXY');
  if (v === undefined || v === 'false') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v; // Express accepts an IP, a subnet or a comma-separated list
}

function parseJwtKeys(r: Reader): JwtKey[] {
  const raw = r.required('JWT_KEYS');
  if (raw === undefined) return [];
  const keys: JwtKey[] = [];
  for (const [i, part] of raw.split(',').entries()) {
    const sep = part.indexOf(':');
    const kid = sep < 0 ? '' : part.slice(0, sep).trim();
    const b64 = sep < 0 ? '' : part.slice(sep + 1).trim();
    const label = `JWT_KEYS entry ${i + 1}`;
    if (!KID_PATTERN.test(kid)) {
      r.fail('JWT_KEYS', `${label} must look like kid:base64 (kid of 1-32 letters, digits, ".", "_" or "-")`);
      continue;
    }
    if (!BASE64_PATTERN.test(b64) || b64.length % 4 !== 0) {
      r.fail('JWT_KEYS', `${label} (${kid}) is not valid base64`);
      continue;
    }
    const secret = Buffer.from(b64, 'base64');
    if (secret.length < MIN_KEY_BYTES) {
      r.fail('JWT_KEYS', `${label} (${kid}) must be at least 256 bits (32 bytes) once decoded`);
      continue;
    }
    if (keys.some((k) => k.kid === kid)) {
      r.fail('JWT_KEYS', `${label}: key id ${kid} is repeated`);
      continue;
    }
    keys.push({ kid, secret });
  }
  return keys;
}

function parseOrigin(r: Reader, nodeEnv: NodeEnv): string {
  const fallback = 'http://localhost:5173';
  const v = r.required('FRONTEND_ORIGIN');
  if (v === undefined) return fallback;
  try {
    const parsed = new URL(v);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== v) throw new Error('shape');
    if (nodeEnv === 'production' && parsed.protocol !== 'https:') {
      r.fail('FRONTEND_ORIGIN', 'must use https in production (NFR-04)');
    }
    return v;
  } catch {
    r.fail('FRONTEND_ORIGIN', 'must be an exact origin such as https://host[:port], without path or trailing slash');
    return fallback;
  }
}

function parseJira(r: Reader): JiraConfig {
  const set = (name: string): string | undefined => {
    const v = r.raw(name);
    return isPlaceholder(v) ? undefined : v;
  };
  const jira: JiraConfig = {};
  const baseUrl = r.url('JIRA_BASE_URL', ['https:'], set('JIRA_BASE_URL'));
  if (baseUrl !== undefined) jira.baseUrl = baseUrl;
  const email = r.email('JIRA_EMAIL', set('JIRA_EMAIL'));
  if (email !== undefined) jira.email = email;
  const apiToken = set('JIRA_API_TOKEN');
  if (apiToken !== undefined) jira.apiToken = apiToken;
  const projectKey = set('JIRA_PROJECT_KEY');
  if (projectKey !== undefined) {
    if (JIRA_KEY_PATTERN.test(projectKey)) jira.projectKey = projectKey;
    else r.fail('JIRA_PROJECT_KEY', 'must be 2-20 characters: capital letters, digits or "_", starting with a letter');
  }
  for (const [name, prop] of [
    ['JIRA_ISSUETYPE_EPIC_ID', 'issueTypeEpicId'],
    ['JIRA_ISSUETYPE_STORY_ID', 'issueTypeStoryId'],
    ['JIRA_ISSUETYPE_SUBTASK_ID', 'issueTypeSubtaskId'],
  ] as const) {
    const v = set(name);
    if (v === undefined) continue;
    if (/^\d+$/.test(v)) jira[prop] = v;
    else r.fail(name, 'must be a numeric Jira issue type id');
  }
  const secret = set('JIRA_WEBHOOK_SECRET');
  if (secret !== undefined) jira.webhookSecret = secret;
  return jira;
}

/**
 * Reads and validates the environment.
 *
 * @param env - Variables to read (defaults to `process.env`).
 * @returns The typed configuration.
 * @throws {ConfigError} Listing every invalid or missing variable.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const r = new Reader(env);

  const nodeEnv = r.oneOf('NODE_ENV', NODE_ENVS, 'development');
  const port = r.int('PORT', { min: 1, max: 65535, fallback: 3000 });
  const logLevel = r.oneOf('LOG_LEVEL', LOG_LEVELS, 'info');
  const trustProxy = parseTrustProxy(r);

  const databaseUrl = r.url('DATABASE_URL', ['postgresql:', 'postgres:'], r.raw('DATABASE_URL'));
  const shadowDatabaseUrl = r.url('SHADOW_DATABASE_URL', ['postgresql:', 'postgres:'], r.raw('SHADOW_DATABASE_URL'));
  const appDatabaseUrl = r.url('APP_DATABASE_URL', ['postgresql:', 'postgres:'], r.required('APP_DATABASE_URL'));
  if (nodeEnv === 'production' && appDatabaseUrl !== undefined && isPlaceholder(appDatabaseUrl)) {
    r.fail('APP_DATABASE_URL', 'still has the .env.example placeholder');
  }

  const jwtKeys = parseJwtKeys(r);
  const jwtAccessTtlSeconds = r.int('JWT_ACCESS_TTL_SECONDS', { min: 60, max: 86_400, fallback: 28_800 });
  const sessionMaxSeconds = r.int('SESSION_MAX_SECONDS', { min: 600, max: 604_800, fallback: 43_200 });
  const bcryptCost = r.int('BCRYPT_COST', { min: 4, max: 15, fallback: 12 });
  if (nodeEnv === 'production' && bcryptCost < 10) r.fail('BCRYPT_COST', 'must be at least 10 in production');

  const frontendOrigin = parseOrigin(r, nodeEnv);
  const rateLimitSessionMax = r.int('RATE_LIMIT_SESSION_MAX', { min: 1, max: 10_000, fallback: 30 });
  const rateLimitSessionWindowMinutes = r.int('RATE_LIMIT_SESSION_WINDOW_MINUTES', {
    min: 1,
    max: 1_440,
    fallback: 15,
  });

  const integrationUserEmail = r.email('INTEGRATION_USER_EMAIL', r.required('INTEGRATION_USER_EMAIL'));

  const seed: AppConfig['seed'] = {};
  const seedName = r.raw('SEED_ADMIN_NAME');
  if (seedName !== undefined) seed.adminName = seedName;
  const seedEmail = r.email('SEED_ADMIN_EMAIL', r.raw('SEED_ADMIN_EMAIL'));
  if (seedEmail !== undefined) seed.adminEmail = seedEmail;

  const jira = parseJira(r);

  if (r.problems.length > 0) throw new ConfigError(r.problems);

  const config: AppConfig = {
    nodeEnv,
    port,
    logLevel,
    trustProxy,
    appDatabaseUrl: appDatabaseUrl ?? '',
    jwtKeys,
    jwtAccessTtlSeconds,
    sessionMaxSeconds,
    bcryptCost,
    frontendOrigin,
    rateLimitSessionMax,
    rateLimitSessionWindowMinutes,
    integrationUserEmail: integrationUserEmail ?? '',
    seed,
    jira,
  };
  if (databaseUrl !== undefined) config.databaseUrl = databaseUrl;
  if (shadowDatabaseUrl !== undefined) config.shadowDatabaseUrl = shadowDatabaseUrl;
  return config;
}
