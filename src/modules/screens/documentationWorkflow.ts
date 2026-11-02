/**
 * Documentation workflow (FR-14, FR-24) — single source of truth for the
 * transitions exposed by PUT /screens/:id/status and POST /screens/:id/review.
 * Confirmed with the department: moving back is allowed; editing an APPROVED
 * screen returns it to IN_PROGRESS; APPROVED is reached only by an
 * Administrator's review. CP-08: a screen IN_REVIEW cannot be edited
 * (PUT /screens/{id}); withdraw it from review first.
 */
import { E } from '../../security/errors.js';
export type DocStatus = 'UNDOCUMENTED' | 'DRAFT' | 'IN_PROGRESS' | 'IN_REVIEW' | 'APPROVED';
export type Role = 'ADMINISTRATOR' | 'DEVELOPER' | 'READER';
export type Trigger = 'STATUS' | 'REVIEW_APPROVE' | 'REVIEW_RETURN' | 'EDIT';

type Rule = {
  from: DocStatus;
  to: DocStatus;
  trigger: Trigger;
  roles: Role[];
  requires?: 'COMPLETE_TEMPLATE' | 'COMMENT';
};
const AD: Role[] = ['ADMINISTRATOR', 'DEVELOPER'];

export const TRANSITIONS: readonly Rule[] = [
  { from: 'UNDOCUMENTED', to: 'DRAFT', trigger: 'STATUS', roles: AD },
  { from: 'DRAFT', to: 'UNDOCUMENTED', trigger: 'STATUS', roles: AD },
  { from: 'DRAFT', to: 'IN_PROGRESS', trigger: 'STATUS', roles: AD },
  { from: 'IN_PROGRESS', to: 'DRAFT', trigger: 'STATUS', roles: AD },
  { from: 'IN_PROGRESS', to: 'IN_REVIEW', trigger: 'STATUS', roles: AD, requires: 'COMPLETE_TEMPLATE' },
  { from: 'IN_REVIEW', to: 'IN_PROGRESS', trigger: 'STATUS', roles: AD }, // withdraw
  { from: 'APPROVED', to: 'IN_PROGRESS', trigger: 'STATUS', roles: AD }, // reopen
  { from: 'IN_REVIEW', to: 'APPROVED', trigger: 'REVIEW_APPROVE', roles: ['ADMINISTRATOR'] },
  { from: 'IN_REVIEW', to: 'IN_PROGRESS', trigger: 'REVIEW_RETURN', roles: ['ADMINISTRATOR'], requires: 'COMMENT' },
  { from: 'UNDOCUMENTED', to: 'DRAFT', trigger: 'EDIT', roles: AD }, // first content saved
  { from: 'APPROVED', to: 'IN_PROGRESS', trigger: 'EDIT', roles: AD }, // approved content changed
];

export type Outcome =
  | { ok: true; to: DocStatus }
  | {
      ok: false;
      code: 'INVALID_TRANSITION' | 'FORBIDDEN' | 'TEMPLATE_INCOMPLETE' | 'COMMENT_REQUIRED' | 'NOT_IN_REVIEW';
    };

export function transition(
  from: DocStatus,
  to: DocStatus | null,
  trigger: Trigger,
  role: Role,
  ctx: { templateComplete?: boolean; comment?: string | null } = {},
): Outcome {
  const target = to ?? TRANSITIONS.find((r) => r.from === from && r.trigger === trigger)?.to ?? null;
  const rule = TRANSITIONS.find((r) => r.from === from && r.to === target && r.trigger === trigger);
  if (!rule) return { ok: false, code: trigger.startsWith('REVIEW') ? 'NOT_IN_REVIEW' : 'INVALID_TRANSITION' };
  if (!rule.roles.includes(role)) return { ok: false, code: 'FORBIDDEN' };
  if (rule.requires === 'COMPLETE_TEMPLATE' && !ctx.templateComplete) return { ok: false, code: 'TEMPLATE_INCOMPLETE' };
  if (rule.requires === 'COMMENT' && !ctx.comment?.trim()) return { ok: false, code: 'COMMENT_REQUIRED' };
  return { ok: true, to: rule.to };
}

/**
 * CP-08 guard for PUT /screens/{id}: call it with the CURRENT status (read inside the same
 * transaction, before writing). Throws 422 SCREEN_IN_REVIEW while the screen is IN_REVIEW.
 * Any other status may be edited (APPROVED and UNDOCUMENTED then move with trigger 'EDIT').
 */
export function assertEditable(status: DocStatus): void {
  if (status === 'IN_REVIEW') throw E.screenInReview();
}

/** The seven text fields of the screen template (SRS Table 28; the eighth, future to do, is Jira, D-06). */
export const TEMPLATE_FIELDS = [
  'onStart',
  'workingProcess',
  'architecture',
  'dataModel',
  'requirements',
  'knownIssues',
  'risks',
] as const;

/** Name of a template field. */
export type TemplateField = (typeof TEMPLATE_FIELDS)[number];

/** The template of a screen: every field is text or `null`. */
export type TemplateContent = Readonly<Record<TemplateField, string | null>>;

/**
 * D-81: a template field has content when it is not `null` and is not empty after `trim`.
 *
 * @param value - The text of one template field.
 */
export function hasContent(value: string | null | undefined): boolean {
  return value !== null && value !== undefined && value.trim() !== '';
}

/**
 * D-81: status of a new screen. DRAFT when any template field has content, UNDOCUMENTED otherwise.
 *
 * @param template - The template of the screen being created.
 */
export function initialStatus(template: TemplateContent): 'UNDOCUMENTED' | 'DRAFT' {
  return TEMPLATE_FIELDS.some((field) => hasContent(template[field])) ? 'DRAFT' : 'UNDOCUMENTED';
}

/**
 * D-81: status after a PUT. UNDOCUMENTED becomes DRAFT when some field goes from no content to content; APPROVED
 * becomes IN_PROGRESS when the PUT really changes anything (a column or a nested element); every other case, and a
 * PUT without changes, keeps the status.
 *
 * @param current - Status read inside the transaction, before writing.
 * @param edit - The template before and after, and whether the PUT changes anything at all.
 */
export function statusAfterEdit(
  current: DocStatus,
  edit: { before: TemplateContent; after: TemplateContent; changed: boolean },
): DocStatus {
  if (!edit.changed) return current;
  if (current === 'APPROVED') return 'IN_PROGRESS';
  if (
    current === 'UNDOCUMENTED' &&
    TEMPLATE_FIELDS.some((field) => !hasContent(edit.before[field]) && hasContent(edit.after[field]))
  ) {
    return 'DRAFT';
  }
  return current;
}

/**
 * FR-14: the template fields without content, in the order of SRS Table 28 and with the names of the contract.
 *
 * @param template - The stored template of the screen.
 */
export function missingTemplateFields(template: TemplateContent): TemplateField[] {
  return TEMPLATE_FIELDS.filter((field) => !hasContent(template[field]));
}

/** Result of asking for a change through `/status`: the new status, or why it is refused. */
export type StatusChangeOutcome =
  | { ok: true; to: DocStatus }
  | { ok: false; code: 'INVALID_TRANSITION' | 'FORBIDDEN' }
  | { ok: false; code: 'TEMPLATE_INCOMPLETE'; fields: TemplateField[] };

/**
 * Judges a change requested through `PUT /screens/{id}/status` against Table 61 (SDD Section 9). Any combination
 * that is not a `STATUS` row, the same status included, is INVALID_TRANSITION. Submitting (IN_PROGRESS to
 * IN_REVIEW) needs content in the seven template fields.
 *
 * @param from - Current status, read inside the transaction.
 * @param to - Status the caller asks for.
 * @param role - Role of the caller.
 * @param template - The stored template of the screen.
 */
export function planStatusChange(
  from: DocStatus,
  to: DocStatus,
  role: Role,
  template: TemplateContent,
): StatusChangeOutcome {
  const missing = missingTemplateFields(template);
  const outcome = transition(from, to, 'STATUS', role, { templateComplete: missing.length === 0 });
  if (outcome.ok) return outcome;
  return outcome.code === 'TEMPLATE_INCOMPLETE'
    ? { ok: false, code: 'TEMPLATE_INCOMPLETE', fields: missing }
    : { ok: false, code: outcome.code === 'FORBIDDEN' ? 'FORBIDDEN' : 'INVALID_TRANSITION' };
}

/**
 * Judges a decision of `POST /screens/{id}/review` against Table 61: only IN_REVIEW can be decided
 * (NOT_IN_REVIEW otherwise); returning needs a comment with content (COMMENT_REQUIRED).
 *
 * @param from - Current status, read inside the transaction.
 * @param decision - APPROVE or RETURN.
 * @param role - Role of the caller.
 * @param comment - The comment of the request, if any.
 */
export function planReview(
  from: DocStatus,
  decision: 'APPROVE' | 'RETURN',
  role: Role,
  comment: string | null | undefined,
): Outcome {
  return transition(from, null, decision === 'APPROVE' ? 'REVIEW_APPROVE' : 'REVIEW_RETURN', role, { comment });
}
