/**
 * Authorization table generated from the OpenAPI contract: every operation's
 * x-roles / x-rule (SDD Section 11). The contract is the single source of truth.
 */
import fs from 'node:fs';
import YAML from 'yaml';
export type Role = 'ADMINISTRATOR' | 'DEVELOPER' | 'READER';
export type OperationPolicy = {
  operationId: string;
  method: string;
  path: string;
  expressPath: string;
  roles: Role[];
  rule?: string;
  capability: string;
};

export function loadPolicies(openapiPath: string): Map<string, OperationPolicy> {
  const spec = YAML.parse(fs.readFileSync(openapiPath, 'utf8'));
  const map = new Map<string, OperationPolicy>();
  for (const [path, item] of Object.entries<any>(spec.paths)) {
    for (const method of ['get', 'post', 'put', 'delete', 'patch']) {
      const op = item[method];
      if (!op) continue;
      if (!Array.isArray(op['x-roles'])) throw new Error(`${op.operationId} has no x-roles`); // fail closed
      map.set(op.operationId, {
        operationId: op.operationId,
        method: method.toUpperCase(),
        path,
        expressPath: '/api/v1' + path.replace(/\{(\w+)\}/g, ':$1'),
        roles: op['x-roles'],
        rule: op['x-rule'],
        capability: op['x-capability'],
      });
    }
  }
  return map;
}
