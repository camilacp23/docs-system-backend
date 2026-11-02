/**
 * Maps the Jira issue object to what this system stores (SDD Table 23, Table 53 step 5).
 *
 * @module integrations/jira/mapping
 */
import { JiraProtocolError } from './errors.js';
import type { JiraHierarchyLevel, JiraIssue, JiraStatusCategory } from './types.js';

const CATEGORIES: Readonly<Record<string, JiraStatusCategory>> = {
  new: 'TO_DO',
  indeterminate: 'IN_PROGRESS',
  done: 'DONE',
};

/**
 * Maps a Jira status category key.
 *
 * @param key - `new`, `indeterminate` or `done`.
 * @returns TO_DO, IN_PROGRESS or DONE.
 * @throws {JiraProtocolError} For any other key (for example the legacy `undefined`).
 */
export function mapStatusCategory(key: unknown): JiraStatusCategory {
  const mapped = typeof key === 'string' && Object.hasOwn(CATEGORIES, key) ? CATEGORIES[key] : undefined;
  if (mapped === undefined) throw new JiraProtocolError('status category');
  return mapped;
}

/**
 * Maps Jira's `hierarchyLevel`.
 *
 * @param level - 1 (Epic), 0 (Story and standard types) or -1 (Subtask).
 * @returns EPIC, STANDARD or SUBTASK.
 * @throws {JiraProtocolError} For any other level.
 */
export function mapHierarchyLevel(level: unknown): JiraHierarchyLevel {
  if (level === 1) return 'EPIC';
  if (level === 0) return 'STANDARD';
  if (level === -1) return 'SUBTASK';
  throw new JiraProtocolError('hierarchy level');
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || v === '') throw new JiraProtocolError(what);
  return v;
};

/**
 * Reads an issue object (`GET /issue/{id}` or an element of a search result).
 *
 * @param raw - Parsed JSON.
 * @returns The issue in this system's terms.
 * @throws {JiraProtocolError} When a required field is missing or not modelled.
 */
export function parseIssue(raw: unknown): JiraIssue {
  if (!isObj(raw) || !isObj(raw['fields'])) throw new JiraProtocolError('issue');
  const fields = raw['fields'];
  const status = isObj(fields['status']) ? fields['status'] : undefined;
  const category = status !== undefined && isObj(status['statusCategory']) ? status['statusCategory'] : undefined;
  const type = isObj(fields['issuetype']) ? fields['issuetype'] : undefined;
  if (status === undefined || type === undefined) throw new JiraProtocolError('issue fields');
  const parent = fields['parent'];
  return {
    id: text(raw['id'], 'issue id'),
    key: text(raw['key'], 'issue key'),
    summary: text(fields['summary'], 'summary'),
    status: text(status['name'], 'status'),
    statusCategory: mapStatusCategory(category?.['key']),
    issueType: text(type['name'], 'issue type'),
    hierarchyLevel: mapHierarchyLevel(type['hierarchyLevel']),
    parent: isObj(parent) ? { id: text(parent['id'], 'parent id'), key: text(parent['key'], 'parent key') } : null,
  };
}
