/**
 * Helpers of the Jira webhook tests: signed and hand-built deliveries, and the screens with tickets they act on.
 */
import { bearer } from './app.js';
import type { JiraApp } from './jiraApp.js';
import { insertApplication, insertScreen } from './fixtures.js';
import { signWebhookBody } from './jiraSimulator.js';
import { asUser } from './users.js';

/** Path of the operation. */
export const WEBHOOK_PATH = '/api/v1/integrations/jira/webhook';

/** A ticket created through the API, with the Jira id the webhook identifies it by. */
export type TicketRef = { id: number; key: string; issueId: string };

/** The tickets of a screen created through the API (so they also exist in the simulator). */
export type Arranged = {
  applicationId: number;
  screenId: number;
  epic: TicketRef;
  story: TicketRef;
  subtasks: TicketRef[];
};

/**
 * Posts a delivery: `rawBody` exactly as given, with the headers given (no signature unless the caller adds it).
 *
 * @param t - The application.
 * @param rawBody - The exact bytes of the body.
 * @param headers - Extra headers.
 * @param path - Path to post to (tests also use other spellings of it).
 */
export function post(t: JiraApp, rawBody: string, headers: Record<string, string> = {}, path = WEBHOOK_PATH) {
  return t.http.post(path).set('Content-Type', 'application/json').set(headers).send(rawBody);
}

/** Posts a delivery signed with the secret of the simulator. */
export function postSigned(t: JiraApp, rawBody: string, headers: Record<string, string> = {}, path = WEBHOOK_PATH) {
  return post(t, rawBody, { 'X-Hub-Signature': signWebhookBody(rawBody, t.sim.webhookSecret), ...headers }, path);
}

/** Serializes an `issue_updated` event the way a hand-written test wants it. */
export function updatedBody(
  ticket: TicketRef,
  fields: Record<string, unknown> | undefined,
  timestamp?: number,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    webhookEvent: 'jira:issue_updated',
    ...(timestamp === undefined ? {} : { timestamp }),
    issue: { id: ticket.issueId, key: ticket.key, ...(fields === undefined ? {} : { fields }), ...extra },
  });
}

/** Serializes an `issue_deleted` event. */
export function deletedBody(ticket: TicketRef, timestamp?: number): string {
  return JSON.stringify({
    webhookEvent: 'jira:issue_deleted',
    ...(timestamp === undefined ? {} : { timestamp }),
    issue: { id: ticket.issueId, key: ticket.key },
  });
}

/** The `status` field of an event for a category. */
export const statusField = (category: 'new' | 'indeterminate' | 'done', name?: string) => ({
  name: name ?? { new: 'To Do', indeterminate: 'In Progress', done: 'Done' }[category],
  statusCategory: { key: category },
});

/**
 * Creates a screen with an Epic, a Story and `count` Subtasks through the API.
 *
 * @param t - The application.
 * @param count - Subtasks under the Story.
 */
export async function arrange(t: JiraApp, count = 2): Promise<Arranged> {
  const application = await insertApplication(t);
  const screen = await insertScreen(t, application.id);
  const api = asUser(t, t.users.developer.token);
  const ref = async (row: { id: number; jiraIssueKey: string }): Promise<TicketRef> => ({
    id: row.id,
    key: row.jiraIssueKey,
    issueId: (
      await t.owner.query<{ jira_issue_id: string }>(`SELECT jira_issue_id FROM jira_ticket WHERE id = $1`, [row.id])
    ).rows[0]!.jira_issue_id,
  });
  type Row = { id: number; jiraIssueKey: string };
  type Created = { epic: Row; story: Row; subtask: Row };
  const first = (
    (
      await api.post(`/screens/${screen.id}/jira-ticket`, {
        newStory: { summary: 'Story' },
        subtask: { summary: 'Subtask 1' },
      })
    ).body as { data: Created }
  ).data;
  const subtasks = [await ref(first.subtask)];
  for (let n = 2; n <= count; n++) {
    const next = (
      (
        await api.post(`/screens/${screen.id}/jira-ticket`, {
          storyId: first.story.id,
          subtask: { summary: `Subtask ${n}` },
        })
      ).body as { data: Created }
    ).data;
    subtasks.push(await ref(next.subtask));
  }
  return {
    applicationId: application.id,
    screenId: screen.id,
    epic: await ref(first.epic),
    story: await ref(first.story),
    subtasks,
  };
}

/** A user's `Authorization` header (the webhook needs none; used to show that a Bearer does not matter). */
export const bearerOf = (t: JiraApp) => bearer(t.users.admin.token);
