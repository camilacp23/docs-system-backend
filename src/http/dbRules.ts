/**
 * Translation table of PostgreSQL constraints to API errors (SDD Table 45 note, Phase 3 decisions D-62 to D-65).
 *
 * Every UNIQUE index, PRIMARY KEY, FOREIGN KEY and CHECK of the six migrations has an entry. A constraint that is
 * not listed here is answered as 500 INTERNAL_ERROR and logged, so a new migration can never be translated wrongly
 * by omission; `tests/integration/dbErrors.test.ts` fails when the database has a constraint without an entry.
 *
 * @module http/dbRules
 */

/** What the errorHandler does when the database rejects a statement because of a given constraint. */
export type ConstraintRule =
  /** 409 EMAIL_TAKEN. */
  | { kind: 'emailTaken' }
  /** 409 DUPLICATE_NAME (D-63): `type` is the lowercase noun, `container` is the scope of uniqueness. */
  | { kind: 'duplicateName'; type: string; container: 'application' | 'screen' | 'collection' | 'system' }
  /** 400 VALIDATION_ERROR (D-65). The service validates first with the exact index; this is the fallback. */
  | { kind: 'validation'; field: string; rule: 'unique' | 'CHECK'; message: string }
  /**
   * 400 VALIDATION_ERROR (D-65) only for the operations listed in `fields`; any other operation is a defect (500
   * `reason`). `array` is the array the operation receives and `property` the key of its items that holds the id
   * (absent when the items are plain ids); its position is taken from the body when it can be found.
   */
  | {
      kind: 'operationValidation';
      fields: Readonly<Record<string, { array: string; property?: string; message: string }>>;
      reason: string;
    }
  /** 404 NOT_FOUND on a reference to a row that does not exist. `byOperation` overrides `element`. */
  | { kind: 'notFound'; element: string; byOperation?: Readonly<Record<string, string>> }
  /** 422 SCOPE_MISMATCH, or SCOPE_CONFLICT when the scope of a variable is being changed. */
  | { kind: 'scope' }
  /** 409 REPORT_NOT_READY. */
  | { kind: 'reportNotReady' }
  /** 422 STORY_NOT_IN_SCREEN. */
  | { kind: 'storyNotInScreen' }
  /** 422 CONTEXT_SCREEN_MISMATCH (CP-07, D-64). */
  | { kind: 'contextScreenMismatch' }
  /** 422 CROSS_APPLICATION (trigger enforce_same_application). */
  | { kind: 'crossApplication' }
  /** 422 APP_CONTEXT_PROTECTED (trigger protect_app_context). */
  | { kind: 'appContextProtected' }
  /** 500 INTERNAL_ERROR logged as error: a defect, not a user error. */
  | { kind: 'internal'; reason: string; todo?: string };

const internal = (reason: string, todo?: string): ConstraintRule =>
  todo === undefined ? { kind: 'internal', reason } : { kind: 'internal', reason, todo };
const unique = (field: string): ConstraintRule => ({
  kind: 'validation',
  field,
  rule: 'unique',
  message: 'This value is repeated. Each one must be unique.',
});
const check = (field: string, message: string): ConstraintRule => ({
  kind: 'validation',
  field,
  rule: 'CHECK',
  message,
});
const notBlank = (field: string): ConstraintRule => check(field, 'Must not be blank.');
const notFound = (element: string): ConstraintRule => ({ kind: 'notFound', element });
const dup = (type: string, container: 'application' | 'screen' | 'collection' | 'system'): ConstraintRule => ({
  kind: 'duplicateName',
  type,
  container,
});

const PRIMARY_KEY_TABLES = [
  'app_user',
  'refresh_token',
  'application',
  'documented_element',
  'screen',
  'variable',
  'collection',
  'collection_field',
  'component',
  'screen_variable',
  'screen_collection',
  'variable_collection',
  'dependency',
  'jira_ticket',
  'comment',
  'report',
  'report_file',
  'audit_log',
  'onboarding_progress',
] as const;

const DEPENDENCY_TARGET: ConstraintRule = {
  kind: 'notFound',
  element: 'element',
  byOperation: { createCollection: 'collection', updateCollection: 'collection' },
};

const RULES: Record<string, ConstraintRule> = {
  // ---- UNIQUE (23505)
  app_user_email_key: { kind: 'emailTaken' },
  application_name_key: dup('application', 'system'),
  screen_application_id_name_key: dup('screen', 'application'),
  variable_global_name_key: dup('global variable', 'application'),
  variable_context_name_key: dup('context variable', 'screen'),
  collection_application_id_name_key: dup('collection', 'application'),
  // D-63 (correction): the arrays are replaced whole on every write, so a repeated name comes from the body itself.
  component_screen_id_name_key: unique('components[].name'),
  collection_field_collection_id_name_key: unique('fields[].name'),
  screen_variable_screen_id_variable_id_used_in_key: unique('variableLinks[].usedIn'),
  screen_collection_screen_id_collection_id_used_in_key: unique('collectionLinks[].usedIn'),
  variable_collection_unique_key: unique('variableAssignments[].usedIn'),
  // Dependencies are written by the client through components[].uses and navigations (D-29, SDD 7.2.4).
  dependency_source_target_relation_key: unique('components[].uses'),
  // TODO(Jira module): the sync must upsert by jira_issue_id; until then a duplicate is a defect.
  jira_ticket_jira_issue_id_key: internal('JIRA_DUPLICATE', 'upsert by jira_issue_id (Jira module)'),
  jira_ticket_jira_issue_key_key: internal('JIRA_DUPLICATE', 'upsert by jira_issue_id (Jira module)'),
  jira_ticket_one_epic_per_screen: internal('JIRA_DUPLICATE', 'upsert by jira_issue_id (Jira module)'),
  refresh_token_token_hash_key: internal('TOKEN_HASH_COLLISION'),
  one_app_context_per_application: internal('APP_CONTEXT_DUPLICATE'),
  documented_element_id_type_key: internal('COMPOSITE_KEY'),
  documented_element_id_type_app_key: internal('COMPOSITE_KEY'),
  screen_id_element_type_application_id_key: internal('COMPOSITE_KEY'),
  variable_id_element_type_application_id_key: internal('COMPOSITE_KEY'),
  variable_id_scope_key: internal('COMPOSITE_KEY'),
  collection_id_element_type_application_id_key: internal('COMPOSITE_KEY'),
  component_id_element_type_application_id_key: internal('COMPOSITE_KEY'),
  jira_ticket_id_screen_level_key: internal('COMPOSITE_KEY'),
  // Two environment entries for the same environment (the contract only rejects identical items).
  element_environment_pkey: unique('environments[].environment'),

  // ---- CHECK (23514)
  variable_collection_function_scope_chk: { kind: 'scope' },
  report_published_ready_chk: { kind: 'reportNotReady' },
  report_ready_has_file_chk: internal('REPORT_STATE'),
  context_screen_mismatch: { kind: 'contextScreenMismatch' },
  app_user_email_lowercase_chk: check('email', 'Must be in lowercase.'),
  app_user_email_format_chk: check('email', 'Must be a valid e-mail address.'),
  app_user_name_not_blank_chk: notBlank('name'),
  application_name_not_blank_chk: notBlank('name'),
  application_jira_key_format_chk: check(
    'jiraProjectKey',
    'Must be 2-20 characters: capital letters, digits or "_", starting with a letter.',
  ),
  screen_name_not_blank_chk: notBlank('name'),
  screen_miro_link_https_chk: check('miroLink', 'Must start with https://.'),
  variable_name_not_blank_chk: notBlank('name'),
  variable_origin_used_in_chk: check('originUsedIn', 'Must not be blank or "origin".'),
  collection_name_not_blank_chk: notBlank('name'),
  component_name_not_blank_chk: notBlank('components[].name'),
  component_type_not_blank_chk: notBlank('components[].type'),
  collection_field_name_not_blank_chk: notBlank('fields[].name'),
  collection_field_position_chk: check('fields[].position', 'Must be zero or greater.'),
  screen_variable_used_in_not_blank_chk: notBlank('variableLinks[].usedIn'),
  screen_variable_origin_is_write_chk: check('variableLinks[].usedIn', '"origin" is reserved for WRITE links.'),
  screen_collection_used_in_not_blank_chk: notBlank('collectionLinks[].usedIn'),
  variable_collection_used_in_not_blank_chk: notBlank('variableAssignments[].usedIn'),
  comment_text_not_blank_chk: notBlank('text'),
  // The types of a dependency are derived by the service, never sent by the client (Table 32).
  // A collection derived from itself or a screen navigating to itself: PUT validates it first (D-74, D-84); this is
  // the backstop.
  dependency_no_self_chk: {
    kind: 'operationValidation',
    fields: {
      createCollection: { array: 'derivedFrom', message: 'A collection cannot derive from itself.' },
      updateCollection: { array: 'derivedFrom', message: 'A collection cannot derive from itself.' },
      updateScreen: {
        array: 'navigations',
        property: 'targetScreenId',
        message: 'A screen cannot navigate to itself.',
      },
    },
    reason: 'DEPENDENCY_DERIVED',
  },
  dependency_allowed_pairs_chk: internal('DEPENDENCY_DERIVED'),
  jira_ticket_key_format_chk: internal('JIRA_KEY_FORMAT'),
  jira_ticket_hierarchy_chk: internal('JIRA_HIERARCHY'),
  refresh_token_expiry_chk: internal('REFRESH_TOKEN_EXPIRY'),
  screen_element_type_chk: internal('ELEMENT_TYPE'),
  variable_element_type_chk: internal('ELEMENT_TYPE'),
  collection_element_type_chk: internal('ELEMENT_TYPE'),
  component_element_type_chk: internal('ELEMENT_TYPE'),
  element_environment_type_chk: internal('ELEMENT_TYPE'),
  audit_log_action_chk: internal('AUDIT_LOG'),
  audit_log_event_name_chk: internal('AUDIT_LOG'),
  audit_log_entity_type_chk: internal('AUDIT_LOG'),
  // The contract validates the step (1 to 5) before the service runs; a value outside the range is a defect (D-149).
  onboarding_progress_step_chk: internal('ONBOARDING_STEP'),

  // ---- FOREIGN KEY (23503; RESTRICT on delete arrives as 23001 and is a defect, D-65)
  documented_element_application_id_fkey: notFound('application'),
  report_application_id_fkey: notFound('application'),
  // The service checks that the application exists first; this is the fallback for one that disappears in between.
  onboarding_progress_application_id_fkey: notFound('application'),
  variable_origin_screen_id_fkey: notFound('screen'),
  component_screen_id_fkey: notFound('screen'),
  screen_variable_screen_id_fkey: notFound('screen'),
  screen_collection_screen_id_fkey: notFound('screen'),
  variable_collection_screen_id_fkey: notFound('screen'),
  jira_ticket_screen_id_fkey: notFound('screen'),
  comment_screen_id_fkey: notFound('screen'),
  screen_variable_variable_id_fkey: notFound('variable'),
  variable_collection_variable_id_variable_scope_fkey: notFound('variable'),
  collection_field_collection_id_fkey: notFound('collection'),
  screen_collection_collection_id_fkey: notFound('collection'),
  variable_collection_collection_id_fkey: notFound('collection'),
  report_file_report_id_fkey: notFound('report'),
  // The service checks the exact expected type first; here the element is only known for collections.
  dependency_source_id_source_type_fkey: DEPENDENCY_TARGET,
  dependency_target_id_target_type_fkey: DEPENDENCY_TARGET,
  jira_ticket_parent_ticket_id_screen_id_parent_level_fkey: { kind: 'storyNotInScreen' },
  refresh_token_user_id_fkey: internal('ACTOR_REFERENCE'),
  application_created_by_fkey: internal('ACTOR_REFERENCE'),
  screen_author_id_fkey: internal('ACTOR_REFERENCE'),
  jira_ticket_created_by_fkey: internal('ACTOR_REFERENCE'),
  comment_user_id_fkey: internal('ACTOR_REFERENCE'),
  report_generated_by_fkey: internal('ACTOR_REFERENCE'),
  onboarding_progress_user_id_fkey: internal('ACTOR_REFERENCE'),
  audit_log_actor_user_id_fkey: internal('ACTOR_REFERENCE'),
  screen_id_element_type_application_id_fkey: internal('COMPOSITE_KEY'),
  variable_id_element_type_application_id_fkey: internal('COMPOSITE_KEY'),
  collection_id_element_type_application_id_fkey: internal('COMPOSITE_KEY'),
  component_id_element_type_application_id_fkey: internal('COMPOSITE_KEY'),
  element_environment_element_id_element_type_fkey: internal('COMPOSITE_KEY'),
};

for (const table of PRIMARY_KEY_TABLES) {
  const name = `${table}_pkey`;
  if (!(name in RULES)) RULES[name] = internal('PRIMARY_KEY');
}

/** Constraint name -> rule. */
export const CONSTRAINT_RULES: Readonly<Record<string, ConstraintRule>> = RULES;

/** Names of every constraint with a rule, longest first (used to find a name inside a database message). */
export const KNOWN_CONSTRAINTS: readonly string[] = Object.keys(RULES).sort((a, b) => b.length - a.length);

/** Returns the rule of a constraint, or `undefined` when the table has no entry for it. */
export function ruleFor(constraint: string | undefined): ConstraintRule | undefined {
  return constraint === undefined
    ? undefined
    : Object.prototype.hasOwnProperty.call(RULES, constraint)
      ? RULES[constraint]
      : undefined;
}
