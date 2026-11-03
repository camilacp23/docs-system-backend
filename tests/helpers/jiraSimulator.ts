/**
 * Local Jira Cloud simulator for tests and the sandbox (no dependencies, only `node:http`). It answers the subset the
 * Jira client uses, with the request and response shapes of Jira Cloud REST v3:
 *
 * - `POST /rest/api/3/issue` (fields: project, issuetype, summary, description in ADF, parent) -> 201 `{ id, key, self }`
 * - `GET /rest/api/3/issue/{idOrKey}` -> `{ id, key, self, fields: { summary, status, issuetype, parent, project, ... } }`
 * - `POST /rest/api/3/search/jql` (jql, fields, maxResults, nextPageToken) -> `{ issues, nextPageToken? , isLast }`
 * - `GET /rest/api/3/search` (the retired endpoint) -> 410
 *
 * It checks Basic auth, numbers issues `TECHEA-n`, enforces the hierarchy (Epic 1 > Story 0 > Subtask -1) and gives each
 * status its category. Its OWN control endpoints live under `/__sim/` and are never exposed by the API:
 *
 * - `POST /__sim/reset`
 * - `POST /__sim/faults` `{ kind: '500'|'502'|'503'|'429'|'401'|'403'|'timeout', count?, retryAfterSeconds?, delayMs?, appliesTo? }`
 * - `POST /__sim/fail-after-create` `{ level: 'EPIC'|'STANDARD', count? }` (partial failure)
 * - `POST /__sim/issues/{key}/status` `{ status? | category?, timestamp? }` -> signed webhook delivery
 * - `POST /__sim/issues/{key}/delete` `{ timestamp? }` -> signed webhook delivery
 * - `POST /__sim/issues/{key}/edit` `{ summary?, key?, parentKey?, timestamp? }` -> signed webhook delivery. A new `key`
 *   moves the issue (its children follow) and the old key keeps finding it in a search, as in Jira.
 * - `GET /__sim/state`
 *
 * It listens on 127.0.0.1 only. A `timeout` fault never answers (unless `delayMs` is given) until the client gives up.
 *
 * @module tests/helpers/jiraSimulator
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { JiraConfig } from '../../src/config/env.js';

export type SimFaultKind = '500' | '502' | '503' | '429' | '401' | '403' | 'timeout';
export type SimAppliesTo = 'all' | 'read' | 'create';
type Level = 'EPIC' | 'STANDARD' | 'SUBTASK';

/** Fixed values shared by the simulator, the sandbox environment and the tests. */
export const SIMULATOR_DEFAULTS = {
  projectKey: 'TECHEA',
  issueTypeIds: { epic: '10100', story: '10101', subtask: '10102' },
  firstIssueId: 10000,
} as const;

const TYPES: Record<string, { name: string; level: Level; hierarchyLevel: number; subtask: boolean }> = {
  [SIMULATOR_DEFAULTS.issueTypeIds.epic]: { name: 'Epic', level: 'EPIC', hierarchyLevel: 1, subtask: false },
  [SIMULATOR_DEFAULTS.issueTypeIds.story]: { name: 'Story', level: 'STANDARD', hierarchyLevel: 0, subtask: false },
  [SIMULATOR_DEFAULTS.issueTypeIds.subtask]: { name: 'Subtask', level: 'SUBTASK', hierarchyLevel: -1, subtask: true },
};

type Category = 'new' | 'indeterminate' | 'done';
const STATUSES: { id: string; name: string; category: Category; categoryName: string; categoryId: number }[] = [
  { id: '10', name: 'To Do', category: 'new', categoryName: 'To Do', categoryId: 2 },
  { id: '11', name: 'In Progress', category: 'indeterminate', categoryName: 'In Progress', categoryId: 4 },
  { id: '12', name: 'Done', category: 'done', categoryName: 'Done', categoryId: 3 },
];

type Issue = {
  id: string;
  key: string;
  summary: string;
  typeId: string;
  statusId: string;
  parentKey: string | null;
  /** Keys the issue had before being moved: a search by an old key still finds it, as in Jira. */
  previousKeys: string[];
  description: unknown;
  created: string;
  updated: string;
};
type Fault = {
  kind: SimFaultKind;
  remaining: number;
  retryAfterSeconds: number;
  delayMs: number | null;
  appliesTo: SimAppliesTo;
};
type CallRecord = { method: string; path: string; authorized: boolean; fault: SimFaultKind | null; status: number };

export type JiraSimulatorOptions = {
  /** 0 (default) = a random free port. */
  port?: number;
  email?: string;
  apiToken?: string;
  webhookSecret?: string;
};

/** A running simulator. */
export type JiraSimulator = {
  /** `http://127.0.0.1:<port>` */
  baseUrl: string;
  port: number;
  email: string;
  apiToken: string;
  webhookSecret: string;
  /** Jira section of the configuration that points the client to this simulator. */
  jiraConfig: () => JiraConfig;
  close: () => Promise<void>;
};

/** A signed webhook delivery, as the control endpoints return it. */
export type SimWebhookDelivery = {
  rawBody: string;
  headers: { 'content-type': string; 'x-hub-signature': string; 'x-atlassian-webhook-identifier': string };
  event: Record<string, unknown>;
};

const MAX_BODY = 1_000_000;

/**
 * HMAC-SHA256 signature header of a raw body, in Jira's format.
 *
 * @param rawBody - Exact bytes that will be sent.
 * @param secret - Webhook secret.
 * @returns `sha256=<hex>`.
 */
export function signWebhookBody(rawBody: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) reject(new Error('body too large'));
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function validAdf(node: unknown): boolean {
  if (!isObj(node) || node['type'] !== 'doc' || node['version'] !== 1 || !Array.isArray(node['content'])) return false;
  const walk = (n: unknown): boolean => {
    if (!isObj(n) || typeof n['type'] !== 'string') return false;
    if (n['type'] === 'text') return typeof n['text'] === 'string' && n['text'] !== '';
    return n['content'] === undefined || (Array.isArray(n['content']) && (n['content'] as unknown[]).every(walk));
  };
  return (node['content'] as unknown[]).every(walk);
}

/**
 * Starts a simulator.
 *
 * @param options - Port and credentials; every secret is random unless given.
 * @returns The running simulator.
 */
export async function startJiraSimulator(options: JiraSimulatorOptions = {}): Promise<JiraSimulator> {
  const email = options.email ?? 'sim.account@example.org';
  const apiToken = options.apiToken ?? `sim-token-${randomBytes(12).toString('hex')}`;
  const webhookSecret = options.webhookSecret ?? `sim-webhook-${randomBytes(16).toString('hex')}`;
  const expectedAuth = `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;
  const pending = new Set<NodeJS.Timeout>();

  let issues = new Map<string, Issue>();
  let nextId = SIMULATOR_DEFAULTS.firstIssueId;
  let nextKeyNumber = 1;
  let faults: Fault[] = [];
  let failAfter: { level: Level; count: number } | null = null;
  let createFailures = 0;
  let calls: CallRecord[] = [];
  let baseUrl = '';

  const reset = (): void => {
    issues = new Map();
    nextId = SIMULATOR_DEFAULTS.firstIssueId;
    nextKeyNumber = 1;
    faults = [];
    failAfter = null;
    createFailures = 0;
    calls = [];
  };

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    const text = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(text),
      ...headers,
    });
    res.end(text);
  };
  const jiraError = (res: ServerResponse, status: number, message: string, errors: Record<string, string> = {}): void =>
    send(res, status, { errorMessages: message === '' ? [] : [message], errors });

  const byIdOrKey = (value: string): Issue | undefined =>
    issues.get(value) ?? [...issues.values()].find((i) => i.id === value);

  const statusOf = (i: Issue) => STATUSES.find((s) => s.id === i.statusId) ?? STATUSES[0]!;
  const typeOf = (i: Issue) => TYPES[i.typeId]!;

  const fieldsOf = (i: Issue, withParent = true): Record<string, unknown> => {
    const status = statusOf(i);
    const type = typeOf(i);
    const parent = i.parentKey === null ? undefined : issues.get(i.parentKey);
    return {
      summary: i.summary,
      status: {
        self: `${baseUrl}/rest/api/3/status/${status.id}`,
        id: status.id,
        name: status.name,
        statusCategory: { id: status.categoryId, key: status.category, name: status.categoryName },
      },
      issuetype: {
        id: i.typeId,
        name: type.name,
        subtask: type.subtask,
        hierarchyLevel: type.hierarchyLevel,
      },
      project: { key: SIMULATOR_DEFAULTS.projectKey },
      description: i.description,
      created: i.created,
      updated: i.updated,
      ...(withParent && parent ? { parent: { id: parent.id, key: parent.key, fields: fieldsOf(parent, false) } } : {}),
    };
  };
  const issueJson = (i: Issue): Record<string, unknown> => ({
    id: i.id,
    key: i.key,
    self: `${baseUrl}/rest/api/3/issue/${i.id}`,
    fields: fieldsOf(i),
  });

  const webhookFor = (
    name: 'jira:issue_updated' | 'jira:issue_deleted',
    issue: Issue,
    timestamp: number | undefined,
    changelog?: { from: string; to: string },
  ): SimWebhookDelivery => {
    const event: Record<string, unknown> = {
      timestamp: timestamp ?? Date.now(),
      webhookEvent: name,
      issue: issueJson(issue),
      ...(changelog
        ? { changelog: { items: [{ field: 'status', fromString: changelog.from, toString: changelog.to }] } }
        : {}),
    };
    const rawBody = JSON.stringify(event);
    return {
      rawBody,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature': signWebhookBody(rawBody, webhookSecret),
        'x-atlassian-webhook-identifier': randomUUID(),
      },
      event,
    };
  };

  // ------------------------------------------------------------------ Jira API
  function createIssue(res: ServerResponse, body: unknown): void {
    if (createFailures > 0) {
      createFailures -= 1;
      return jiraError(res, 500, 'Simulated failure after a partial creation');
    }
    const fields = isObj(body) && isObj(body['fields']) ? body['fields'] : null;
    if (fields === null) return jiraError(res, 400, 'Request body must have "fields"');
    const errors: Record<string, string> = {};
    const project = isObj(fields['project']) ? fields['project'] : {};
    if (project['key'] !== SIMULATOR_DEFAULTS.projectKey) errors['project'] = 'Specify a valid project ID or key';
    const issuetype = isObj(fields['issuetype']) ? fields['issuetype'] : {};
    const typeId = typeof issuetype['id'] === 'string' ? issuetype['id'] : '';
    const type = TYPES[typeId];
    if (type === undefined) errors['issuetype'] = 'Specify a valid issue type';
    const summary = fields['summary'];
    if (typeof summary !== 'string' || summary.trim() === '')
      errors['summary'] = 'You must specify a summary of the issue.';
    else if (summary.length > 255) errors['summary'] = 'Summary must be less than 255 characters.';
    else if (/[\r\n]/.test(summary)) errors['summary'] = 'Summary cannot contain line breaks.';
    if (fields['description'] !== undefined && fields['description'] !== null && !validAdf(fields['description'])) {
      errors['description'] = 'Operation value must be an Atlassian Document';
    }
    let parentKey: string | null = null;
    if (type !== undefined) {
      const given = isObj(fields['parent']) ? fields['parent'] : null;
      const lookup =
        given === null
          ? undefined
          : byIdOrKey(
              typeof given['key'] === 'string' ? given['key'] : typeof given['id'] === 'string' ? given['id'] : '',
            );
      const wanted = type.level === 'SUBTASK' ? 0 : type.level === 'STANDARD' ? 1 : null;
      if (type.level === 'EPIC' && given !== null)
        errors['parent'] = 'Given parent work item does not belong to appropriate hierarchy.';
      else if (type.level === 'SUBTASK' && given === null) errors['parent'] = 'Sub-task must have a parent.';
      else if (given !== null) {
        if (lookup === undefined) errors['parent'] = 'Parent work item could not be found.';
        else if (typeOf(lookup).hierarchyLevel !== wanted)
          errors['parent'] = 'Given parent work item does not belong to appropriate hierarchy.';
        else parentKey = lookup.key;
      }
    }
    if (Object.keys(errors).length > 0 || type === undefined) return jiraError(res, 400, '', errors);

    const stamp = new Date().toISOString();
    const issue: Issue = {
      id: String(nextId++),
      key: `${SIMULATOR_DEFAULTS.projectKey}-${nextKeyNumber++}`,
      summary: summary as string,
      typeId,
      statusId: STATUSES[0]!.id,
      parentKey,
      previousKeys: [],
      description: fields['description'] ?? null,
      created: stamp,
      updated: stamp,
    };
    issues.set(issue.key, issue);
    if (failAfter !== null && failAfter.level === type.level) {
      createFailures = failAfter.count;
      failAfter = null;
    }
    send(res, 201, { id: issue.id, key: issue.key, self: `${baseUrl}/rest/api/3/issue/${issue.id}` });
  }

  /** Evaluates the JQL subset: `project = X`, `key|issuekey = / in (...)`, `parent = / in (...)`, joined by AND. */
  function matchJql(jql: string): ((i: Issue) => boolean) | null {
    const clauses = jql.replace(/\s+order\s+by\s+.*$/i, '').split(/\s+and\s+/i);
    const tests: ((i: Issue) => boolean)[] = [];
    for (const raw of clauses) {
      const clause = raw.trim();
      let m = /^project\s*=\s*"?([A-Za-z0-9_]+)"?$/i.exec(clause);
      if (m) {
        const project = m[1]!.toUpperCase();
        tests.push(() => project === SIMULATOR_DEFAULTS.projectKey);
        continue;
      }
      m = /^(key|issuekey|parent)\s*(?:=\s*"?([A-Za-z0-9_-]+)"?|in\s*\(([^)]*)\))$/i.exec(clause);
      if (!m) return null;
      const values = (m[2] !== undefined ? [m[2]] : m[3]!.split(',')).map((v) =>
        v.trim().replace(/^"|"$/g, '').toUpperCase(),
      );
      if (values.some((v) => !/^[A-Z][A-Z0-9_]*-\d+$/.test(v))) return null;
      const set = new Set(values);
      tests.push(
        m[1]!.toLowerCase() === 'parent'
          ? (i) => i.parentKey !== null && set.has(i.parentKey)
          : (i) => set.has(i.key) || i.previousKeys.some((k) => set.has(k)),
      );
    }
    return (i) => tests.every((t) => t(i));
  }

  function search(res: ServerResponse, body: unknown): void {
    const jql = isObj(body) && typeof body['jql'] === 'string' ? body['jql'] : '';
    const match = jql.trim() === '' ? null : matchJql(jql);
    if (match === null)
      return jiraError(res, 400, `Error in the JQL Query: unsupported or invalid query. (simulator subset)`);
    const max = Math.min(Math.max(Number(isObj(body) ? body['maxResults'] : 50) || 50, 1), 100);
    const token = isObj(body) && typeof body['nextPageToken'] === 'string' ? body['nextPageToken'] : '';
    const offset = token === '' ? 0 : Number.parseInt(Buffer.from(token, 'base64url').toString('utf8'), 10);
    if (Number.isNaN(offset) || offset < 0) return jiraError(res, 400, 'Invalid nextPageToken');
    const all = [...issues.values()].filter(match).sort((a, b) => Number(a.id) - Number(b.id));
    const page = all.slice(offset, offset + max);
    const more = offset + max < all.length;
    send(res, 200, {
      issues: page.map(issueJson),
      isLast: !more,
      ...(more ? { nextPageToken: Buffer.from(String(offset + max)).toString('base64url') } : {}),
    });
  }

  // ------------------------------------------------------------------- control
  async function control(req: IncomingMessage, res: ServerResponse, path: string): Promise<number> {
    const method = req.method ?? 'GET';
    const parsed = method === 'POST' ? parseJson(await readBody(req)) : {};
    const body = isObj(parsed) ? parsed : {};
    if (method === 'GET' && path === '/__sim/state') {
      send(res, 200, {
        issues: [...issues.values()].map((i) => ({
          id: i.id,
          key: i.key,
          summary: i.summary,
          level: typeOf(i).level,
          status: statusOf(i).name,
          parentKey: i.parentKey,
        })),
        faults: faults.map((f) => ({ kind: f.kind, remaining: f.remaining, appliesTo: f.appliesTo })),
        failAfterCreate: failAfter,
        pendingCreateFailures: createFailures,
        calls,
      });
      return 200;
    }
    if (method !== 'POST') return notFound(res);
    if (path === '/__sim/reset') {
      reset();
      send(res, 200, { ok: true });
      return 200;
    }
    if (path === '/__sim/faults') {
      const kind = body['kind'] as SimFaultKind;
      if (!['500', '502', '503', '429', '401', '403', 'timeout'].includes(kind)) return bad(res, 'unknown fault kind');
      const appliesTo = (body['appliesTo'] ?? 'all') as SimAppliesTo;
      if (!['all', 'read', 'create'].includes(appliesTo)) return bad(res, 'unknown appliesTo');
      faults.push({
        kind,
        remaining: Math.max(1, Number(body['count'] ?? 1) || 1),
        retryAfterSeconds: Number(body['retryAfterSeconds'] ?? 1) || 1,
        delayMs: typeof body['delayMs'] === 'number' ? body['delayMs'] : null,
        appliesTo,
      });
      send(res, 200, { ok: true });
      return 200;
    }
    if (path === '/__sim/fail-after-create') {
      const level = body['level'];
      if (level !== 'EPIC' && level !== 'STANDARD') return bad(res, 'level must be EPIC or STANDARD');
      failAfter = { level, count: Math.max(1, Number(body['count'] ?? 1) || 1) };
      send(res, 200, { ok: true });
      return 200;
    }
    const issueRoute = /^\/__sim\/issues\/([A-Za-z0-9_-]+)\/(status|delete|edit)$/.exec(path);
    if (issueRoute) {
      const issue = byIdOrKey(issueRoute[1]!);
      if (issue === undefined) return notFound(res);
      const timestamp = typeof body['timestamp'] === 'number' ? body['timestamp'] : undefined;
      if (issueRoute[2] === 'delete') {
        const delivery = webhookFor('jira:issue_deleted', issue, timestamp);
        issues.delete(issue.key);
        send(res, 200, delivery);
        return 200;
      }
      if (issueRoute[2] === 'edit') {
        if (typeof body['summary'] === 'string') issue.summary = body['summary'];
        if (body['parentKey'] !== undefined)
          issue.parentKey = typeof body['parentKey'] === 'string' ? body['parentKey'] : null;
        if (typeof body['key'] === 'string' && body['key'] !== issue.key) {
          const oldKey = issue.key;
          issues.delete(oldKey);
          issue.previousKeys.push(oldKey);
          issue.key = body['key'];
          issues.set(issue.key, issue);
          for (const child of issues.values()) if (child.parentKey === oldKey) child.parentKey = issue.key;
        }
        issue.updated = new Date().toISOString();
        send(res, 200, webhookFor('jira:issue_updated', issue, timestamp));
        return 200;
      }
      const target = STATUSES.find((s) =>
        typeof body['status'] === 'string'
          ? s.name.toLowerCase() === body['status'].toLowerCase()
          : s.category === body['category'],
      );
      if (target === undefined)
        return bad(res, 'give a known status (To Do, In Progress, Done) or a category (new, indeterminate, done)');
      const from = statusOf(issue).name;
      issue.statusId = target.id;
      issue.updated = new Date().toISOString();
      send(res, 200, webhookFor('jira:issue_updated', issue, timestamp, { from, to: target.name }));
      return 200;
    }
    return notFound(res);
  }

  const bad = (res: ServerResponse, message: string): number => {
    jiraError(res, 400, message);
    return 400;
  };
  const notFound = (res: ServerResponse): number => {
    jiraError(res, 404, 'Not found');
    return 404;
  };

  // ------------------------------------------------------------------- routing
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://sim');
    const path = url.pathname;
    const record: CallRecord = { method, path, authorized: false, fault: null, status: 0 };
    res.on('finish', () => {
      record.status = res.statusCode;
    });
    if (path.startsWith('/__sim/')) {
      await control(req, res, path);
      return;
    }
    calls.push(record);
    const isRead = method === 'GET' || path === '/rest/api/3/search/jql';
    const isCreate = method === 'POST' && path === '/rest/api/3/issue';
    const fault = faults.find(
      (f) => f.remaining > 0 && (f.appliesTo === 'all' || (f.appliesTo === 'read' ? isRead : isCreate)),
    );
    if (fault !== undefined) {
      fault.remaining -= 1;
      record.fault = fault.kind;
      if (fault.kind === 'timeout') {
        if (fault.delayMs === null) return; // never answers; the client's timeout ends the call
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            pending.delete(timer);
            resolve();
          }, fault.delayMs!);
          pending.add(timer);
          res.on('close', () => {
            clearTimeout(timer);
            pending.delete(timer);
            resolve();
          });
        });
        if (res.destroyed) return;
      } else if (fault.kind === '429') {
        return send(res, 429, { message: 'Rate limit exceeded' }, { 'retry-after': String(fault.retryAfterSeconds) });
      } else if (fault.kind === '401') {
        return send(res, 401, { message: 'Client must be authenticated to access this resource.' });
      } else if (fault.kind === '403') {
        return send(res, 403, { errorMessages: ['Forbidden'], errors: {} });
      } else {
        return jiraError(res, Number(fault.kind), 'Simulated outage');
      }
    }
    if (req.headers.authorization !== expectedAuth) {
      return send(res, 401, { message: 'Client must be authenticated to access this resource.' });
    }
    record.authorized = true;

    if (method === 'GET' && path === '/rest/api/3/search')
      return jiraError(res, 410, 'The requested API has been removed. Use /rest/api/3/search/jql.');
    if (method === 'GET') {
      const m = /^\/rest\/api\/3\/issue\/([A-Za-z0-9_-]+)$/.exec(path);
      const issue = m ? byIdOrKey(m[1]!) : undefined;
      if (m === null) return jiraError(res, 404, 'Not found');
      if (issue === undefined)
        return jiraError(res, 404, 'Issue does not exist or you do not have permission to see it.');
      return send(res, 200, issueJson(issue));
    }
    if (method === 'POST' && (path === '/rest/api/3/issue' || path === '/rest/api/3/search/jql')) {
      const parsed = parseJson(await readBody(req));
      if (parsed === undefined) return jiraError(res, 400, 'Invalid JSON');
      return path === '/rest/api/3/issue' ? createIssue(res, parsed) : search(res, parsed);
    }
    return jiraError(res, 404, 'Not found');
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) jiraError(res, 500, 'Simulator error');
      else res.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    port,
    email,
    apiToken,
    webhookSecret,
    jiraConfig: () => ({
      baseUrl,
      email,
      apiToken,
      projectKey: SIMULATOR_DEFAULTS.projectKey,
      issueTypeEpicId: SIMULATOR_DEFAULTS.issueTypeIds.epic,
      issueTypeStoryId: SIMULATOR_DEFAULTS.issueTypeIds.story,
      issueTypeSubtaskId: SIMULATOR_DEFAULTS.issueTypeIds.subtask,
      webhookSecret,
    }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const t of pending) clearTimeout(t);
        pending.clear();
        server.close(() => resolve());
        server.closeAllConnections(); // also ends calls held open by a `timeout` fault
      }),
  };
}

function parseJson(text: string): unknown {
  if (text === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
