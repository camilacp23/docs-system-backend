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
