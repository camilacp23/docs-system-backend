/** Run: npx tsx tests/06_documentation_workflow.test.ts */
import { transition, assertEditable } from '../src/modules/screens/documentationWorkflow.js';
import { ApiError } from '../src/security/errors.js';
let fail = 0;
const eq = (label: string, got: unknown, exp: unknown) => { const ok = JSON.stringify(got) === JSON.stringify(exp); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : ` got ${JSON.stringify(got)}`}`); };
eq('W01 developer submits a complete screen', transition('IN_PROGRESS', 'IN_REVIEW', 'STATUS', 'DEVELOPER', { templateComplete: true }), { ok: true, to: 'IN_REVIEW' });
eq('W02 submit with incomplete template', transition('IN_PROGRESS', 'IN_REVIEW', 'STATUS', 'DEVELOPER', { templateComplete: false }), { ok: false, code: 'TEMPLATE_INCOMPLETE' });
eq('W03 nobody sets APPROVED through /status', transition('IN_REVIEW', 'APPROVED', 'STATUS', 'ADMINISTRATOR'), { ok: false, code: 'INVALID_TRANSITION' });
eq('W04 administrator approves', transition('IN_REVIEW', null, 'REVIEW_APPROVE', 'ADMINISTRATOR'), { ok: true, to: 'APPROVED' });
eq('W05 developer cannot approve', transition('IN_REVIEW', null, 'REVIEW_APPROVE', 'DEVELOPER'), { ok: false, code: 'FORBIDDEN' });
eq('W06 return without comment', transition('IN_REVIEW', null, 'REVIEW_RETURN', 'ADMINISTRATOR', { comment: '  ' }), { ok: false, code: 'COMMENT_REQUIRED' });
eq('W07 return with comment', transition('IN_REVIEW', null, 'REVIEW_RETURN', 'ADMINISTRATOR', { comment: 'Faltan riesgos' }), { ok: true, to: 'IN_PROGRESS' });
eq('W08 review of a screen not in review', transition('DRAFT', null, 'REVIEW_APPROVE', 'ADMINISTRATOR'), { ok: false, code: 'NOT_IN_REVIEW' });
eq('W09 moving back is allowed (IN_PROGRESS -> DRAFT)', transition('IN_PROGRESS', 'DRAFT', 'STATUS', 'DEVELOPER'), { ok: true, to: 'DRAFT' });
eq('W10 editing an APPROVED screen reopens it', transition('APPROVED', null, 'EDIT', 'DEVELOPER'), { ok: true, to: 'IN_PROGRESS' });
eq('W11 first content moves UNDOCUMENTED to DRAFT', transition('UNDOCUMENTED', null, 'EDIT', 'DEVELOPER'), { ok: true, to: 'DRAFT' });
eq('W12 skipping steps is rejected (UNDOCUMENTED -> IN_REVIEW)', transition('UNDOCUMENTED', 'IN_REVIEW', 'STATUS', 'DEVELOPER', { templateComplete: true }), { ok: false, code: 'INVALID_TRANSITION' });
eq('W13 reader cannot change status', transition('DRAFT', 'IN_PROGRESS', 'STATUS', 'READER'), { ok: false, code: 'FORBIDDEN' });
// CP-08: no editing while in review
const editOutcome = (status: Parameters<typeof assertEditable>[0]) => {
  try { assertEditable(status); return { ok: true }; }
  catch (e) { return e instanceof ApiError ? { ok: false, status: e.status, code: e.code, message: e.message } : { ok: false, error: String(e) }; }
};
eq('W14 editing a screen IN_REVIEW -> 422 SCREEN_IN_REVIEW', editOutcome('IN_REVIEW'),
   { ok: false, status: 422, code: 'SCREEN_IN_REVIEW', message: 'This screen is in review. Edit it after the review, or withdraw it from review.' });
const withdrawn = transition('IN_REVIEW', 'IN_PROGRESS', 'STATUS', 'DEVELOPER');
eq('W15 editing after withdrawing from review is allowed', { withdrawn, edit: withdrawn.ok ? editOutcome(withdrawn.to) : null },
   { withdrawn: { ok: true, to: 'IN_PROGRESS' }, edit: { ok: true } });
console.log(fail === 0 ? 'ALL PASSED' : `${fail} FAILURE(S)`); process.exit(fail ? 1 : 0);
