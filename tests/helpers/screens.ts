/**
 * Helpers of the screens tests: the contract's response shapes and typed readers of the responses. Everything runs on
 * the disposable database of `startTestApp`.
 */
import type { RefBody } from './variables.js';

/** The seven template fields of a screen. */
export type TemplateBody = {
  onStart: string | null;
  workingProcess: string | null;
  architecture: string | null;
  dataModel: string | null;
  requirements: string | null;
  knownIssues: string | null;
  risks: string | null;
};

/** A use of a variable or collection by a component, as the API returns it. */
export type UseBody = {
  id: number;
  targetType: 'VARIABLE' | 'COLLECTION';
  target: RefBody;
  description: string | null;
};

/** A component as the API returns it. */
export type ComponentBody = {
  id: number;
  name: string;
  type: string;
  onSelect: string | null;
  description: string | null;
  uses: UseBody[];
};

/** A link to a variable as the API returns it. */
export type VariableLinkBody = {
  id: number;
  variable: RefBody;
  accessMode: string;
  usedIn: string;
  isOrigin: boolean;
};

/** A link to a collection as the API returns it. */
export type CollectionLinkBody = { id: number; collection: RefBody; accessMode: string; usedIn: string };

/** A navigation as the API returns it. */
export type NavigationBody = { id: number; targetScreen: RefBody; description: string | null };

/** A screen as GET, POST and PUT return it. */
export type ScreenBody = {
  id: number;
  applicationId: number;
  name: string;
  isAppContext: boolean;
  documentationStatus: string;
  author: RefBody;
  pendingSubtasks: number;
  commentCount: number;
  createdAt: string;
  updatedAt: string;
  miroLink: string | null;
  template: TemplateBody;
  components: ComponentBody[];
  variableLinks: VariableLinkBody[];
  collectionLinks: CollectionLinkBody[];
  navigations: NavigationBody[];
};

/** Typed view of a single-screen response. */
export const screenOf = (res: { body: unknown }): ScreenBody => (res.body as { data: ScreenBody }).data;

/** The `details` of an error response, untyped. */
export const detailsOf = (res: { body: unknown }): Record<string, unknown> =>
  (res.body as { details: Record<string, unknown> }).details;

/** A template without content. */
export const emptyTemplate = (): TemplateBody => ({
  onStart: null,
  workingProcess: null,
  architecture: null,
  dataModel: null,
  requirements: null,
  knownIssues: null,
  risks: null,
});

let counter = 0;

/** A unique valid screen name. */
export const uniqueScreenName = (prefix = 'Screen test '): string => `${prefix}${(counter += 1)}`;

/** A valid `POST /screens` body with optional overrides (an empty template and no nested items). */
export const createBodyOf = (applicationId: number, over: Record<string, unknown> = {}) => ({
  applicationId,
  name: uniqueScreenName(),
  template: emptyTemplate(),
  components: [],
  variableLinks: [],
  collectionLinks: [],
  navigations: [],
  ...over,
});

/** The body of a `PUT /screens/{id}` that changes nothing (ids included, origin rows left out), with overrides. */
export const putBodyOf = (s: ScreenBody, over: Record<string, unknown> = {}) => ({
  name: s.name,
  miroLink: s.miroLink,
  template: s.template,
  components: s.components.map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    onSelect: c.onSelect,
    description: c.description,
    uses: c.uses.map((u) => ({
      id: u.id,
      targetType: u.targetType,
      targetId: u.target.id,
      description: u.description,
    })),
  })),
  variableLinks: s.variableLinks
    .filter((l) => !l.isOrigin)
    .map((l) => ({ id: l.id, variableId: l.variable.id, accessMode: l.accessMode, usedIn: l.usedIn })),
  collectionLinks: s.collectionLinks.map((l) => ({
    id: l.id,
    collectionId: l.collection.id,
    accessMode: l.accessMode,
    usedIn: l.usedIn,
  })),
  navigations: s.navigations.map((n) => ({ id: n.id, targetScreenId: n.targetScreen.id, description: n.description })),
  ...over,
});

/** A template with content in the given fields. */
export const templateWith = (over: Partial<TemplateBody>): TemplateBody => ({ ...emptyTemplate(), ...over });

/** Creates a screen through the API as `api` and returns it with its ETag; fails the test if it is not 201. */
export async function createScreenVia(
  api: {
    post: (
      path: string,
      body: object,
    ) => PromiseLike<{ status: number; body: unknown; headers: Record<string, unknown> }>;
  },
  applicationId: number,
  over: Record<string, unknown> = {},
): Promise<{ screen: ScreenBody; etag: string }> {
  const res = await api.post('/screens', createBodyOf(applicationId, over));
  if (res.status !== 201) throw new Error(`fixture failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { screen: screenOf(res), etag: String(res.headers.etag) };
}
