/**
 * The link of a Jira ticket (contract schema `JiraTicket.url`): `<base>/browse/<key>` with a configured base URL and
 * null without one, because a relative link is not a URL (FR-12, NFR-14).
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTicketView } from '../../src/modules/screens/jiraView.js';
import type { TicketRow } from '../../src/modules/screens/jiraRepository.js';

const row: TicketRow = {
  id: 1,
  jiraIssueKey: 'TECHEA-3',
  hierarchyLevel: 'STANDARD',
  issueType: 'Story',
  summary: 'A story',
  status: 'To Do',
  statusCategory: 'TO_DO',
  lastSyncedAt: new Date('2026-11-14T10:00:00.000Z'),
};

describe('createTicketView: the ticket url', () => {
  it('is <base>/browse/<key> with a configured base URL', () => {
    assert.equal(
      createTicketView('https://example.atlassian.net')(row).url,
      'https://example.atlassian.net/browse/TECHEA-3',
    );
  });

  it('drops trailing slashes of the base URL', () => {
    assert.equal(
      createTicketView('https://example.atlassian.net//')(row).url,
      'https://example.atlassian.net/browse/TECHEA-3',
    );
  });

  it('is null when Jira has no base URL (undefined or empty)', () => {
    assert.equal(createTicketView(undefined)(row).url, null);
    assert.equal(createTicketView('')(row).url, null);
    assert.equal(createTicketView('/')(row).url, null);
  });
});
