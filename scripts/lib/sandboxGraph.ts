/**
 * Logic of `npm run sandbox:graph`: loads an application of about 500 nodes, with every kind of edge and cycles of
 * DERIVES_FROM and NAVIGATES_TO, into the local sandbox THROUGH THE API (so every row is validated and audited), to
 * demonstrate the dependency map at department scale (NFR-11).
 *
 * Safeguards: the base URL is a constant, never an argument; the client refuses any other URL; before it writes
 * anything, the run must find the application "Sandbox Fixtures" by reading, which only `npm run sandbox:db` creates.
 * Every name carries a prefix (random by default) and the application is named after it, so the script can run twice on
 * the same sandbox. The planning functions are pure and are covered by unit tests; the API is injected.
 *
 * @module scripts/lib/sandboxGraph
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

/** The only API this script talks to: the sandbox API on this machine. */
export const SANDBOX_GRAPH_BASE_URL = 'http://localhost:3001/api/v1';
/** The application that proves the database is the sandbox (created by `npm run sandbox:db`). */
export const SANDBOX_FIXTURES_NAME = 'Sandbox Fixtures';
export const DEFAULT_NODES = 500;
export const MIN_NODES = 50;
export const MAX_NODES = 1000;

/**
 * Refuses any API other than the sandbox's.
 *
 * @param baseUrl - URL the client is about to use.
 * @throws {Error} Unless it is exactly {@link SANDBOX_GRAPH_BASE_URL}.
 */
export function assertSandboxBaseUrl(baseUrl: string): void {
  if (baseUrl !== SANDBOX_GRAPH_BASE_URL) {
    throw new Error(`Refusing to run: the only API this script may use is ${SANDBOX_GRAPH_BASE_URL}`);
  }
}

/**
 * Text of an error answer of the API: status, `code`, `message` and, when there are, every field of `details.fields`
 * (field, rule, message) or the rest of `details`. None of that is secret; the request, its headers and the token are
 * never part of it.
 *
 * @param what - What the script was doing.
 * @param status - HTTP status.
 * @param body - Parsed body of the answer.
 */
export function formatApiError(what: string, status: number, body: unknown): string {
  const e = body as { code?: string; message?: string; details?: unknown } | undefined;
  const reason = [e?.code, e?.message].filter((part) => part !== undefined && part !== '').join(': ');
  const lines = [`${what}: the API answered ${status}${reason === '' ? '' : ` ${reason}`}`];
  const details = e?.details as { fields?: unknown } | null | undefined;
  if (details && typeof details === 'object') {
    const { fields, ...rest } = details as { fields?: { field?: unknown; rule?: unknown; message?: unknown }[] };
    for (const f of Array.isArray(fields) ? fields : []) {
      lines.push(`  - ${String(f.field)} [${String(f.rule)}]: ${String(f.message)}`);
    }
    if (Object.keys(rest).length > 0) lines.push(`  details: ${JSON.stringify(rest)}`);
  }
  return lines.join('\n');
}

/** Options of a run. */
export type GraphOptions = { nodes: number; prefix: string };

/**
 * Reads the command line. There is no option for the URL or the database on purpose.
 *
 * @param argv - Arguments after the script name.
 * @param randomPrefix - Source of the default prefix (injectable for tests).
 * @throws {Error} For an unknown option, a bad value or `--nodes` outside the range.
 */
export function parseGraphArgs(
  argv: readonly string[],
  randomPrefix: () => string = () => randomBytes(3).toString('hex'),
): GraphOptions {
  let nodes = DEFAULT_NODES;
  let prefix: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (flag === '--nodes') {
      nodes = Number(value);
      i += 1;
    } else if (flag === '--prefix') {
      prefix = value;
      i += 1;
    } else {
      throw new Error(
        `Unknown option "${flag}". Usage: npm run sandbox:graph -- [--nodes <50-1000>] [--prefix <text>]`,
      );
    }
  }
  if (!Number.isInteger(nodes) || nodes < MIN_NODES || nodes > MAX_NODES) {
    throw new Error(`--nodes must be a whole number from ${MIN_NODES} to ${MAX_NODES}`);
  }
  const chosen = prefix ?? randomPrefix();
  if (!/^[A-Za-z0-9]{3,12}$/.test(chosen)) throw new Error('--prefix must be 3 to 12 letters or digits');
  return { nodes, prefix: chosen };
}

/** How many elements of each kind the application will have (screens exclude App (OnStart), which already exists). */
export type Plan = { screens: number; variables: number; collections: number; components: number };

/**
 * Splits `total` nodes: 8% screens (App (OnStart) included), 24% variables, 12% collections and the rest components.
 * With 500 that is 40 screens (39 plus App), 120 variables, 60 collections and 280 components.
 *
 * @param total - Number of nodes the graph will have, App (OnStart) included.
 */
export function planGraph(total: number): Plan {
  const screens = Math.max(3, Math.round(total * 0.08) - 1);
  const variables = Math.round(total * 0.24);
  const collections = Math.max(4, Math.round(total * 0.12));
  return { screens, variables, collections, components: total - (screens + 1) - variables - collections };
}

/** A variable created by a screen is context-scoped every sixth time; every sixth variable has no origin screen. */
export const isUntraced = (variable: number): boolean => variable % 6 === 0;
export const isContext = (variable: number): boolean => variable % 6 === 1;
/** Links, uses and assignments point only at global variables. */
export const linkableVariables = (plan: Plan): number[] =>
  Array.from({ length: plan.variables }, (_, i) => i).filter((i) => !isContext(i));

/** Origin screen (index among the plan's screens) of a variable, or null when it has none. */
export const originOf = (variable: number, plan: Plan): number | null =>
  isUntraced(variable) ? null : variable % plan.screens;

/** Ring: element `i` points at the next one, the last at the first (a cycle of the whole set). */
export const ringNext = (i: number, size: number): number => (i + 1) % size;

/** What a component uses: three of every four a variable, the fourth a collection. */
export function useOf(component: number, plan: Plan): { type: 'VARIABLE' | 'COLLECTION'; index: number } {
  const variables = linkableVariables(plan);
  return component % 4 === 0
    ? { type: 'COLLECTION', index: component % plan.collections }
    : { type: 'VARIABLE', index: variables[component % variables.length]! };
}

/** Links of one screen: four variables and four collections, each with its own `usedIn`. */
export function linksOf(screen: number, plan: Plan): { variables: number[]; collections: number[] } {
  const variables = linkableVariables(plan);
  return {
    variables: [0, 1, 2, 3].map((j) => variables[(screen * 3 + j) % variables.length]!),
    collections: [0, 1, 2, 3].map((j) => (screen + j) % plan.collections),
  };
}

/** Variables assigned by a collection (FEEDS): collection `c` feeds the `c`-th linkable variable, up to the shorter list. */
export function feedsOf(plan: Plan): { collection: number; variable: number }[] {
  const variables = linkableVariables(plan);
  return Array.from({ length: Math.min(plan.collections, variables.length) }, (_, c) => ({
    collection: c,
    variable: variables[c]!,
  }));
}

/** Nodes by type and edges by kind the graph must have after the load (the App (OnStart) screen is counted). */
export type Expected = { nodes: Record<string, number>; edges: Record<string, number> };

/**
 * What `GET /dependencies/graph` must return once the plan is loaded.
 *
 * @param plan - Result of {@link planGraph}.
 */
export function expectedGraph(plan: Plan): Expected {
  const created = Array.from({ length: plan.variables }, (_, i) => i).filter((i) => !isUntraced(i)).length;
  return {
    nodes: {
      SCREEN: plan.screens + 1,
      VARIABLE: plan.variables,
      COLLECTION: plan.collections,
      COMPONENT: plan.components,
    },
    edges: {
      CONTAINS: plan.components,
      CREATES: created,
      ACCESSES: plan.screens * 8,
      FEEDS: feedsOf(plan).length,
      USES: plan.components,
      DERIVES_FROM: plan.collections,
      NAVIGATES_TO: plan.screens,
    },
  };
}

// ---------------------------------------------------------------------------------------------------- the API

/** What the script needs from the API; the real one is {@link createSandboxApi}, tests pass a fake. */
export type SandboxApi = {
  get(path: string): Promise<{ status: number; body: unknown; headers: Record<string, string> }>;
  send(
    method: 'POST' | 'PUT',
    path: string,
    body: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: unknown; headers: Record<string, string> }>;
};

/**
 * Reads the administrator credentials of the sandbox from the git-ignored file `npm run sandbox:db` writes. Nothing else
 * is read and the values are never printed.
 *
 * @param file - Path of that file.
 * @throws {Error} When the file or the two keys are missing.
 */
export function readSandboxAdmin(file: string): { email: string; password: string } {
  if (!existsSync(file))
    throw new Error('The sandbox credentials file does not exist. Run `npm run sandbox:db` first.');
  const values = new Map<string, string>();
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0) values.set(line.slice(0, eq), line.slice(eq + 1));
  }
  const email = values.get('SANDBOX_ADMIN_EMAIL');
  const password = values.get('SANDBOX_ADMIN_PASSWORD');
  if (!email || !password)
    throw new Error('The sandbox credentials file has no administrator. Run `npm run sandbox:db`.');
  return { email, password };
}

/**
 * The real client: `fetch` against the sandbox API with the administrator's token. It refuses any other base URL.
 *
 * @param baseUrl - Must be {@link SANDBOX_GRAPH_BASE_URL}.
 * @param admin - Administrator credentials from {@link readSandboxAdmin}.
 * @throws {Error} For another URL, an unreachable API or a failed login (the reason never includes the password).
 */
export async function createSandboxApi(
  baseUrl: string,
  admin: { email: string; password: string },
  fetchImpl: typeof fetch = fetch,
): Promise<SandboxApi> {
  assertSandboxBaseUrl(baseUrl);
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
    token?: string,
  ) => {
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
          ...extra,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error(`The sandbox API does not answer at ${baseUrl}. Run \`npm run sandbox:api\` first.`);
    }
    const text = await res.text();
    return {
      status: res.status,
      body: text === '' ? undefined : (JSON.parse(text) as unknown),
      headers: Object.fromEntries(res.headers.entries()),
    };
  };
  const login = await call('POST', '/auth/login', { email: admin.email, password: admin.password });
  const token = (login.body as { data?: { accessToken?: string } } | undefined)?.data?.accessToken;
  if (login.status !== 200 || token === undefined) {
    throw new Error(
      `${formatApiError('The administrator of the sandbox could not log in', login.status, login.body)}\nRun \`npm run sandbox:db\`.`,
    );
  }
  return {
    get: (path) => call('GET', path, undefined, {}, token),
    send: (method, path, body, headers) => call(method, path, body, headers, token),
  };
}

type Data = { data: Record<string, unknown> & { id: number } };

/** Result of a run. */
export type GraphRunResult = {
  applicationId: number;
  applicationName: string;
  expected: Expected;
  actual: Expected;
  matches: boolean;
  graphReadMs: number;
  neighborhood: { path: string; nodes: number };
  requests: number;
};

/**
 * Loads the application and checks the graph the API returns against the plan.
 *
 * @param api - The sandbox API (or a fake).
 * @param options - Nodes and prefix.
 * @param log - Progress lines.
 * @throws {Error} When Sandbox Fixtures is not found (nothing was written), or when the API rejects a request.
 */
export async function runSandboxGraph(
  api: SandboxApi,
  options: GraphOptions,
  log: (line: string) => void = () => undefined,
): Promise<GraphRunResult> {
  let requests = 0;
  const ok = async <T>(
    p: Promise<{ status: number; body: unknown; headers: Record<string, string> }>,
    what: string,
  ) => {
    const res = await p;
    requests += 1;
    if (res.status < 200 || res.status >= 300) {
      throw new Error(formatApiError(what, res.status, res.body));
    }
    return res as { status: number; body: T; headers: Record<string, string> };
  };

  // 1. Safeguard, by reading: this must be the sandbox.
  const found = await ok<{ data: { id: number; name: string }[] }>(
    api.get(`/applications?q=${encodeURIComponent(SANDBOX_FIXTURES_NAME)}&pageSize=100`),
    'Looking for Sandbox Fixtures',
  );
  if (!found.body.data.some((a) => a.name === SANDBOX_FIXTURES_NAME)) {
    throw new Error(
      `Refusing to write: the application "${SANDBOX_FIXTURES_NAME}" was not found, so this does not look like the sandbox. ` +
        'Run `npm run sandbox:db` and `npm run sandbox:api` first.',
    );
  }

  const plan = planGraph(options.nodes);
  const p = options.prefix;
  const name = `Graph demo ${p}`;
  const template = {
    onStart: null,
    workingProcess: null,
    architecture: null,
    dataModel: null,
    requirements: null,
    knownIssues: null,
    risks: null,
  };

  // 2. The application and its App (OnStart) screen.
  const app = await ok<Data>(
    api.send('POST', '/applications', { name, platform: 'Power Apps' }),
    'Creating the application',
  );
  const applicationId = app.body.data.id;
  log(`Application "${name}" (id ${applicationId})`);
  const appScreens = await ok<{ data: { id: number; name: string }[] }>(
    api.get(`/screens?applicationId=${applicationId}`),
    'Reading App (OnStart)',
  );
  const appScreenId = appScreens.body.data.find((s) => s.name === 'App (OnStart)')!.id;

  // 3. Screens (empty at first: their components, links and navigations need the other elements).
  const screenIds: number[] = [];
  for (let s = 0; s < plan.screens; s += 1) {
    const created = await ok<Data>(
      api.send('POST', '/screens', {
        applicationId,
        name: `${p}Scr${s}`,
        miroLink: s % 3 === 0 ? `https://miro.com/app/board/${p}${s}/` : null,
        template,
        components: [],
        variableLinks: [],
        collectionLinks: [],
        navigations: [],
      }),
      `Creating screen ${s}`,
    );
    screenIds.push(created.body.data.id);
  }
  log(`${plan.screens} screens`);

  // 4. Variables.
  const variableIds: number[] = [];
  for (let v = 0; v < plan.variables; v += 1) {
    const origin = originOf(v, plan);
    const created = await ok<Data>(
      api.send('POST', '/variables', {
        applicationId,
        name: `${p}Var${v}`,
        dataType: 'TEXT',
        scope: isContext(v) ? 'CONTEXT' : 'GLOBAL',
        ...(origin === null ? {} : { originScreenId: screenIds[origin] }),
        environments: v % 3 === 0 ? [{ environment: 'DEV' }, { environment: 'PROD' }] : [{ environment: 'DEV' }],
      }),
      `Creating variable ${v}`,
    );
    variableIds.push(created.body.data.id);
  }
  log(`${plan.variables} variables`);

  // 5. Collections: the assignments (FEEDS) and the derivations (DERIVES_FROM) as a ring closed by one PUT.
  const feeds = feedsOf(plan);
  const assignmentsOf = (c: number) =>
    feeds
      .filter((f) => f.collection === c)
      .map((f) => ({
        variableId: variableIds[f.variable],
        screenId: appScreenId,
        assignmentFunction: 'SET',
        tableFunction: c % 2 === 0 ? 'First' : null,
        usedIn: `OnStart.col${c}`,
      }));
  const environmentsOf = (c: number) => (c % 4 === 0 ? [{ environment: 'PROD' }] : [{ environment: 'DEV' }]);
  const collectionIds: number[] = [];
  let firstEtag = '';
  for (let c = 0; c < plan.collections; c += 1) {
    const created = await ok<Data>(
      api.send('POST', '/collections', {
        applicationId,
        name: `${p}Col${c}`,
        environments: environmentsOf(c),
        variableAssignments: assignmentsOf(c),
        derivedFrom: c === 0 ? [] : [collectionIds[c - 1]],
      }),
      `Creating collection ${c}`,
    );
    collectionIds.push(created.body.data.id);
    if (c === 0) firstEtag = created.headers['etag'] ?? '';
  }
  await ok(
    api.send(
      'PUT',
      `/collections/${collectionIds[0]}`,
      {
        name: `${p}Col0`,
        environments: environmentsOf(0),
        variableAssignments: assignmentsOf(0),
        derivedFrom: [collectionIds[plan.collections - 1]],
      },
      { 'If-Match': firstEtag },
    ),
    'Closing the DERIVES_FROM ring',
  );
  log(`${plan.collections} collections, DERIVES_FROM ring closed`);

  // 6. Screens again, now complete: components with their uses, links and the NAVIGATES_TO ring.
  const componentsByScreen: number[][] = screenIds.map(() => []);
  for (let k = 0; k < plan.components; k += 1) componentsByScreen[k % plan.screens]!.push(k);
  for (let s = 0; s < plan.screens; s += 1) {
    const links = linksOf(s, plan);
    await ok(
      api.send('PUT', `/screens/${screenIds[s]}`, {
        name: `${p}Scr${s}`,
        miroLink: s % 3 === 0 ? `https://miro.com/app/board/${p}${s}/` : null,
        template,
        components: componentsByScreen[s]!.map((k) => {
          const use = useOf(k, plan);
          return {
            name: `cmp${k}`,
            type: k % 2 === 0 ? 'Button' : 'Gallery',
            onSelect: null,
            description: null,
            uses: [
              {
                targetType: use.type,
                targetId: use.type === 'VARIABLE' ? variableIds[use.index] : collectionIds[use.index],
                description: null,
              },
            ],
          };
        }),
        variableLinks: links.variables.map((v, j) => ({
          variableId: variableIds[v],
          accessMode: 'READ_WRITE',
          usedIn: `Control${j}.Text`,
        })),
        collectionLinks: links.collections.map((c, j) => ({
          collectionId: collectionIds[c],
          accessMode: 'READ',
          usedIn: `Gallery${j}.Items`,
        })),
        navigations: [{ targetScreenId: screenIds[ringNext(s, plan.screens)], description: null }],
      }),
      `Completing screen ${s}`,
    );
  }
  log(`${plan.components} components, links and NAVIGATES_TO ring`);

  // 7. What the API says about it.
  const started = performance.now();
  const graph = await ok<{ data: { nodes: { type: string }[]; edges: { kind: string }[] } }>(
    api.get(`/dependencies/graph?applicationId=${applicationId}`),
    'Reading the graph',
  );
  const graphReadMs = performance.now() - started;
  const count = (items: string[]): Record<string, number> =>
    items.reduce<Record<string, number>>((acc, item) => ({ ...acc, [item]: (acc[item] ?? 0) + 1 }), {});
  const expected = expectedGraph(plan);
  const actual: Expected = {
    nodes: count(graph.body.data.nodes.map((n) => n.type)),
    edges: count(graph.body.data.edges.map((e) => e.kind)),
  };
  const same = (a: Record<string, number>, b: Record<string, number>): boolean =>
    Object.keys({ ...a, ...b }).every((key) => (a[key] ?? 0) === (b[key] ?? 0));
  const neighborhoodPath = `/dependencies/collections/${collectionIds[0]}?depth=2`;
  const around = await ok<{ data: { nodes: unknown[] } }>(api.get(neighborhoodPath), 'Reading a neighborhood');
  return {
    applicationId,
    applicationName: name,
    expected,
    actual,
    matches: same(expected.nodes, actual.nodes) && same(expected.edges, actual.edges),
    graphReadMs,
    neighborhood: { path: `/api/v1${neighborhoodPath}`, nodes: around.body.data.nodes.length },
    requests,
  };
}

/** What the command line needs from outside; the script passes only `envFile`, tests pass the rest. */
export type CliDeps = {
  /** Git-ignored credentials file written by `npm run sandbox:db`. */
  envFile: string;
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** `fetch` of the client (tests route it to an in-process server). */
  fetchImpl?: typeof fetch;
  /** Source of the default prefix. */
  randomPrefix?: () => string;
};

/**
 * `npm run sandbox:graph` from the arguments to the exit code: reads the arguments and the credentials, logs in, loads
 * the graph through the API and prints the result. This is the one entry point the script and its tests share.
 *
 * @param argv - Arguments after the script name.
 * @param deps - Credentials file and, for tests, the output, the `fetch` and the prefix source.
 * @returns 0 when the graph was loaded and matches the plan, 1 otherwise (the reason goes to `deps.error`).
 */
export async function runSandboxGraphCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  try {
    const options = parseGraphArgs(argv, deps.randomPrefix);
    const api = await createSandboxApi(SANDBOX_GRAPH_BASE_URL, readSandboxAdmin(deps.envFile), deps.fetchImpl);
    const result = await runSandboxGraph(api, options, log);

    const row = (counts: Record<string, number>) =>
      Object.entries(counts)
        .map(([key, n]) => `${key}=${n}`)
        .join(', ');
    log('');
    log(`Application: ${result.applicationName} (id ${result.applicationId}), prefix ${options.prefix}`);
    log(`Nodes: ${row(result.actual.nodes)}`);
    log(`Edges: ${row(result.actual.edges)}`);
    log(`The graph matches the plan: ${result.matches ? 'yes' : 'NO'}`);
    log(`GET /dependencies/graph took ${result.graphReadMs.toFixed(1)} ms (${result.requests} requests in all)`);
    log('');
    log('To look at it:');
    log(`  GET ${SANDBOX_GRAPH_BASE_URL}/dependencies/graph?applicationId=${result.applicationId}`);
    log(
      `  GET ${SANDBOX_GRAPH_BASE_URL.replace('/api/v1', '')}${result.neighborhood.path}  (${result.neighborhood.nodes} nodes)`,
    );
    if (!result.matches) {
      error(`Expected nodes ${row(result.expected.nodes)} and edges ${row(result.expected.edges)}`);
      return 1;
    }
    return 0;
  } catch (e) {
    error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
