/**
 * Authorization table generated from the OpenAPI contract: every operation's
 * x-roles / x-rule (SDD Section 11). The contract is the single source of truth.
 */
import fs from 'node:fs';
import YAML from 'yaml';

export type Role = 'ADMINISTRATOR' | 'DEVELOPER' | 'READER';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

/** `sort` query parameter of a listing: the whitelist comes from the contract's description of the parameter. */
export type SortPolicy = { allowed: string[]; default: string | undefined };

export type OperationPolicy = {
  operationId: string;
  method: HttpMethod;
  path: string;
  expressPath: string;
  roles: Role[];
  rule?: string;
  capability: string;
  sort?: SortPolicy;
};

const ROLES: readonly Role[] = ['ADMINISTRATOR', 'DEVELOPER', 'READER'];
const METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

const toRoles = (operationId: string, value: unknown): Role[] => {
  if (!Array.isArray(value)) throw new Error(`${operationId} has no x-roles`); // fail closed
  return value.map((v) => {
    const role = ROLES.find((r) => r === v);
    if (role === undefined) throw new Error(`${operationId} declares an unknown role in x-roles`);
    return role;
  });
};

/** Reads `Allowed: a, b, c; prefix - for descending.` from the description of the operation's `sort` parameter. */
const toSortPolicy = (parameters: unknown): SortPolicy | undefined => {
  if (!Array.isArray(parameters)) return undefined;
  for (const p of parameters) {
    if (!isRecord(p) || p.name !== 'sort' || p.in !== 'query') continue;
    const match = typeof p.description === 'string' ? /Allowed:\s*([^;.]+)/.exec(p.description) : null;
    const allowed = (match?.[1] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const schema = isRecord(p.schema) ? p.schema : {};
    return { allowed, default: typeof schema.default === 'string' ? schema.default : undefined };
  }
  return undefined;
};

export function loadPolicies(openapiPath: string): Map<string, OperationPolicy> {
  const spec: unknown = YAML.parse(fs.readFileSync(openapiPath, 'utf8'));
  const paths = isRecord(spec) && isRecord(spec.paths) ? spec.paths : {};
  const map = new Map<string, OperationPolicy>();
  for (const [path, item] of Object.entries(paths)) {
    if (!isRecord(item)) continue;
    for (const method of METHODS) {
      const op = item[method.toLowerCase()];
      if (!isRecord(op)) continue;
      const operationId = String(op.operationId);
      const policy: OperationPolicy = {
        operationId,
        method,
        path,
        expressPath: '/api/v1' + path.replace(/\{(\w+)\}/g, ':$1'),
        roles: toRoles(operationId, op['x-roles']),
        capability: String(op['x-capability']),
      };
      if (typeof op['x-rule'] === 'string') policy.rule = op['x-rule'];
      const sort = toSortPolicy(op.parameters);
      if (sort) policy.sort = sort;
      map.set(operationId, policy);
    }
  }
  return map;
}
