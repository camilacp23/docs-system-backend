/** Security configuration (NFR-01, NFR-06). Every secret comes from the environment; nothing is hard-coded. */
export const security = {
  issuer: 'docs-system-api',
  audience: 'docs-system-web',
  /** Signing keys by key id. JWT_KEYS = "kid1:base64secret,kid2:base64secret"; the FIRST signs, all verify (rotation). */
  keys: parseKeys(process.env.JWT_KEYS ?? ''),
  accessTtlSeconds: Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 8 * 60 * 60), // NFR-01: 8 h, configurable
  /** Absolute session lifetime: fixed at login, NOT extended by refresh rotation (confirmed: one workday). */
  sessionMaxSeconds: Number(process.env.SESSION_MAX_SECONDS ?? 12 * 60 * 60),
  bcryptCost: Number(process.env.BCRYPT_COST ?? 12),
  allowedOrigin: process.env.FRONTEND_ORIGIN ?? 'https://localhost:5173',
  refreshCookie: { name: 'rt', path: '/api/v1/auth' },
  loginRateLimit: { windowMs: 15 * 60 * 1000, maxFailures: 5 },
  /**
   * CP-06: e-mail of the reserved account "Integración Jira" (READER, INACTIVE). It is the
   * actor of webhook writes, it cannot log in, it is hidden from GET /users, answers 404 on
   * GET /users/{id}, and cannot be changed (422 RESERVED_ACCOUNT). Mandatory: the API
   * refuses to start without it.
   */
  integrationUserEmail: requireEmail('INTEGRATION_USER_EMAIL'),
};

/** Values of the validated application configuration (src/config) that the security layer reads. */
export type SecurityOverrides = {
  keys: { kid: string; secret: Buffer }[];
  accessTtlSeconds: number;
  sessionMaxSeconds: number;
  bcryptCost: number;
  allowedOrigin: string;
  integrationUserEmail: string;
};

/**
 * Makes the security layer use the validated configuration of the real application (`buildApp`).
 * The Phase 2 harness never calls it and keeps reading `process.env`.
 */
export function configureSecurity(overrides: SecurityOverrides): void {
  Object.assign(security, overrides);
}

/** True when `email` is the reserved integration account (comparison in lowercase, as stored). */
export const isIntegrationEmail = (email: string | null | undefined) =>
  !!email && email.trim().toLowerCase() === security.integrationUserEmail;

function requireEmail(name: string): string {
  const v = (process.env[name] ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) {
    throw new Error(
      `${name} is required (e-mail of the reserved integration account, SDD D-31 / CP-06). Set it in .env.`,
    );
  }
  return v;
}
function parseKeys(raw: string): { kid: string; secret: Buffer }[] {
  const keys = raw
    .split(',')
    .filter(Boolean)
    .map((p) => {
      const [kid, b64] = p.split(':') as [string, string];
      return { kid, secret: Buffer.from(b64, 'base64') };
    });
  for (const k of keys) if (k.secret.length < 32) throw new Error(`JWT key ${k.kid} must be at least 256 bits`);
  return keys;
}
