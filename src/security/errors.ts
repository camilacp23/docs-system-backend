/**
 * Uniform error format { code, message, details } (SRS 3.7).
 * Messages in English (CP-04), with the text of the error catalog in openapi.yaml
 * (info.description). Values in <...> in the catalog are filled in from `details`.
 */
/** One entry of `details.fields` in a VALIDATION_ERROR (SDD Table 59). */
export type FieldError = { field: string; rule: string; message: string };

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: unknown = null,
  ) {
    super(message);
  }
}

export const E = {
  // 400
  validation: (fields: FieldError[] = []) =>
    new ApiError(400, 'VALIDATION_ERROR', 'Check the highlighted fields.', { fields }),
  // 401
  invalidCredentials: () => new ApiError(401, 'INVALID_CREDENTIALS', 'The email or password is incorrect.'),
  unauthenticated: () => new ApiError(401, 'UNAUTHENTICATED', 'Your session is not valid. Sign in again.'),
  tokenExpired: () => new ApiError(401, 'TOKEN_EXPIRED', 'Your session is not valid. Sign in again.'),
  refreshInvalid: () => new ApiError(401, 'REFRESH_INVALID', 'Your session ended. Sign in again to continue.'),
  invalidSignature: () => new ApiError(401, 'INVALID_SIGNATURE', 'Invalid webhook signature.'),
  // 403
  forbidden: (requiredRoles: string[]) =>
    new ApiError(403, 'FORBIDDEN', "Your role doesn't allow this action.", { requiredRoles }),
  /** CSRF guard of refresh/logout; not in the user catalog (the real frontend never triggers it). */
  originRejected: () => new ApiError(403, 'FORBIDDEN', "This request's origin isn't allowed.", { reason: 'ORIGIN' }),
  // 404
  /** `field` (D-75) names the position of a nested id in the payload (for example `fields[2].id`). */
  notFound: (element: string, id?: number | string, field?: string) =>
    new ApiError(404, 'NOT_FOUND', `This ${element} doesn't exist. It may have been deleted.`, {
      element,
      id: id ?? null,
      ...(field === undefined ? {} : { field }),
    }),
  /** Phase 3 decision: a contract operation without a module handler yet (development only). */
  notImplemented: () =>
    new ApiError(404, 'NOT_FOUND', "This resource doesn't exist. It may have been deleted.", {
      element: 'resource',
      id: null,
      reason: 'NOT_IMPLEMENTED',
    }),
  /** Phase 3 decision: no route (or no method) in the contract matches the request. */
  routeNotFound: () =>
    new ApiError(404, 'NOT_FOUND', "This resource doesn't exist. It may have been deleted.", {
      element: 'resource',
      id: null,
      reason: 'ROUTE_NOT_FOUND',
    }),
  // 409
  /**
   * D-63: `type` is the lowercase noun ("global variable"), `application` is the scope where the name must be
   * unique (application, screen, collection or the product) and `container` says which one it is.
   */
  duplicateName: (
    type: string,
    name: string,
    application: string,
    container: 'application' | 'screen' | 'collection' | 'system' = 'application',
  ) =>
    new ApiError(
      409,
      'DUPLICATE_NAME',
      `${/^[aeiou]/i.test(type) ? 'An' : 'A'} ${type} named ${name} already exists in ${application}.`,
      { field: 'name', type, name, application, container },
    ),
  emailTaken: () => new ApiError(409, 'EMAIL_TAKEN', 'A user with this email already exists.', { field: 'email' }),
  reportNotReady: (status: string) =>
    new ApiError(409, 'REPORT_NOT_READY', 'Only ready reports can be published or downloaded.', { status }),
  // 412 / 413
  preconditionFailed: (element: string, currentETag: string) =>
    new ApiError(
      412,
      'PRECONDITION_FAILED',
      `Someone else saved changes to this ${element} after you opened it. Reload to see their version.`,
      { element, currentETag },
    ),
  payloadTooLarge: () =>
    new ApiError(
      413,
      'PAYLOAD_TOO_LARGE',
      'This is too much text to save at once. Shorten the longest fields and try again.',
    ),
  // 422
  scopeMismatch: (field?: string) =>
    new ApiError(
      422,
      'SCOPE_MISMATCH',
      'Set applies to global variables and UpdateContext to context variables.',
      field ? { field } : null,
    ),
  scopeConflict: (fn: 'Set' | 'UpdateContext') =>
    new ApiError(
      422,
      'SCOPE_CONFLICT',
      `You can't change the scope while collections assign this variable with ${fn}. Update those assignments first.`,
      { function: fn },
    ),
  /** D-76: `field` is the position of the first element of another application in the payload. */
  crossApplication: (field?: string) =>
    new ApiError(
      422,
      'CROSS_APPLICATION',
      'You can only link elements of the same application.',
      field === undefined ? null : { field },
    ),
  invalidOriginScreen: () =>
    new ApiError(422, 'INVALID_ORIGIN_SCREEN', 'Context variables are created inside a screen, not in App (OnStart).', {
      field: 'originScreenId',
    }),
  /**
   * D-68: the origin screen belongs to another application. `screen` and `application` are names (the frontend fills
   * the message from `details`); `application` is the application of the variable.
   */
  invalidOriginScreenOtherApplication: (screenId: number, screen: string, application: string) =>
    new ApiError(
      422,
      'INVALID_ORIGIN_SCREEN',
      `${screen} belongs to another application. Choose a screen of ${application}.`,
      { field: 'originScreenId', screenId, screen, application },
    ),
  /**
   * CP-07 / D-64. Raised from the database (trigger check_context_screen_links) and translated by errorHandler.
   * `originScreen` is the name of the variable's origin screen (null when it has none); `screenId` and
   * `targetScreen` identify the screen where the link was attempted.
   */
  contextScreenMismatch: (d: {
    variableId: number;
    variable: string;
    originScreenId: number | null;
    originScreen: string | null;
    /** `null` when the screen is being created (D-85). */
    screenId: number | null;
    targetScreen: string;
    /** D-76: position of the assignment in the payload (absent when the database raises it). */
    field?: string;
  }) =>
    d.originScreenId === null || d.originScreen === null
      ? new ApiError(
          422,
          'CONTEXT_SCREEN_MISMATCH',
          `${d.variable} has no origin screen. Set its origin screen before linking it.`,
          {
            variableId: d.variableId,
            variable: d.variable,
            originScreenId: null,
            screenId: d.screenId,
            targetScreen: d.targetScreen,
            ...(d.field === undefined ? {} : { field: d.field }),
          },
        )
      : new ApiError(
          422,
          'CONTEXT_SCREEN_MISMATCH',
          `${d.variable} belongs to ${d.originScreen}. From here you can only write it with Navigate.`,
          {
            variableId: d.variableId,
            variable: d.variable,
            originScreenId: d.originScreenId,
            screen: d.originScreen,
            screenId: d.screenId,
            targetScreen: d.targetScreen,
            ...(d.field === undefined ? {} : { field: d.field }),
          },
        ),
  lastActiveAdmin: () =>
    new ApiError(
      422,
      'LAST_ACTIVE_ADMIN',
      'There must be at least one active administrator. Promote another user first.',
    ),
  cannotDeactivateSelf: () => new ApiError(422, 'CANNOT_DEACTIVATE_SELF', "You can't deactivate your own account."),
  /** CP-06 */
  reservedAccount: () => new ApiError(422, 'RESERVED_ACCOUNT', "This is a system account and can't be changed."),
  /** CP-01 */
  applicationArchived: (applicationId: number) =>
    new ApiError(422, 'APPLICATION_ARCHIVED', "This application is archived, so its documentation can't be changed.", {
      applicationId,
    }),
  invalidTransition: (from: string, to: string | null) =>
    new ApiError(422, 'INVALID_TRANSITION', 'This screen changed status meanwhile. Reload to see its current status.', {
      from,
      to,
    }),
  notInReview: () =>
    new ApiError(422, 'NOT_IN_REVIEW', 'This screen is no longer in review. Reload to see its status.'),
  /** CP-08 */
  screenInReview: () =>
    new ApiError(
      422,
      'SCREEN_IN_REVIEW',
      'This screen is in review. Edit it after the review, or withdraw it from review.',
    ),
  templateIncomplete: (fields: string[]) =>
    new ApiError(
      422,
      'TEMPLATE_INCOMPLETE',
      `Complete all seven template fields to submit for review. Missing: ${fields.join(', ')}.`,
      { fields },
    ),
  commentRequired: () =>
    new ApiError(422, 'COMMENT_REQUIRED', 'Write a comment: it is required to return the documentation.'),
  /** CP-11 */
  reviewCommentLocked: () => new ApiError(422, 'REVIEW_COMMENT_LOCKED', "Review decisions can't be edited."),
  /** D-87: the App (OnStart) screen cannot be deleted (trigger) nor renamed (service). */
  appContextProtected: (action: 'delete' | 'rename' = 'delete') =>
    new ApiError(
      422,
      'APP_CONTEXT_PROTECTED',
      action === 'rename' ? "The App (OnStart) screen can't be renamed." : "The App (OnStart) screen can't be deleted.",
    ),
  storyNotInScreen: (storyId: number) =>
    new ApiError(
      422,
      'STORY_NOT_IN_SCREEN',
      "That story doesn't belong to this screen. Refresh the list and pick again.",
      { storyId },
    ),
  // 429 / 500 / 502
  rateLimited: (minutes: number) =>
    new ApiError(429, 'RATE_LIMITED', `Too many attempts. Try again in ${minutes} minutes.`, { minutes }),
  internal: (requestId: string) =>
    new ApiError(
      500,
      'INTERNAL_ERROR',
      `Something went wrong on our side. Try again in a moment. Reference: ${requestId}.`,
      { requestId },
    ),
  jiraUnavailable: () =>
    new ApiError(
      502,
      'JIRA_UNAVAILABLE',
      "Jira isn't responding. The to-do wasn't created. Try again in a few minutes.",
    ),
  jiraPartialFailure: (key: string, created: unknown, storyId: number) =>
    new ApiError(
      502,
      'JIRA_PARTIAL_FAILURE',
      `The story ${key} was created, but the to-do wasn't. Try again to add it to that story.`,
      { key, created, storyId },
    ),
};
