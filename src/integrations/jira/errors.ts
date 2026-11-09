/**
 * Typed errors of the Jira client. They know nothing about the HTTP of this API: the service layer decides which
 * `ApiError` each one becomes (JIRA_UNAVAILABLE, JIRA_PARTIAL_FAILURE). No message ever includes a URL, a header,
 * a token or a response body.
 *
 * @module integrations/jira/errors
 */

/** Base class of every error raised by the Jira client. */
export class JiraError extends Error {
  constructor(
    message: string,
    /** Stable machine-readable reason. */
    public readonly reason: string,
    /** True when the failure counts toward the circuit breaker (Jira unreachable or misbehaving). */
    public readonly availability: boolean,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** The Jira variables needed for the call are missing (D-89). No network call was made. */
export class JiraNotConfiguredError extends JiraError {
  constructor(public readonly missing: readonly string[]) {
    super(`Jira is not configured (missing: ${missing.join(', ')})`, 'NOT_CONFIGURED', false);
  }
}

/** The circuit breaker is open: the call was not attempted. */
export class JiraCircuitOpenError extends JiraError {
  constructor(public readonly retryAfterMs: number) {
    super('Jira calls are suspended after repeated failures', 'CIRCUIT_OPEN', false);
  }
}

/** Network failure, timeout, 5xx, 429, unexpected redirect or an unreadable 2xx body. */
export class JiraUnavailableError extends JiraError {
  constructor(
    reason: 'NETWORK' | 'TIMEOUT' | 'SERVER_ERROR' | 'RATE_LIMITED' | 'REDIRECT' | 'BAD_RESPONSE',
    /** HTTP status when Jira answered. */
    public readonly status?: number,
  ) {
    super(`Jira is unavailable (${reason}${status === undefined ? '' : ` ${status}`})`, reason, true);
  }
}

/** 401 or 403: the credentials or the permissions of the technical account are wrong (configuration). */
export class JiraConfigurationError extends JiraError {
  constructor(
    reason: 'AUTH_REJECTED' | 'FORBIDDEN',
    public readonly status: 401 | 403,
  ) {
    super(
      reason === 'AUTH_REJECTED'
        ? 'Jira rejected the credentials of the technical account (check JIRA_EMAIL and JIRA_API_TOKEN)'
        : 'The technical account lacks permission in Jira (check its project permissions)',
      reason,
      true,
    );
  }
}

/** Jira answered but refused the request (400, 404, ...): the request or the resource is wrong, Jira is up. */
export class JiraRequestError extends JiraError {
  constructor(
    public readonly status: number,
    /** Messages Jira sent (`errorMessages` and `errors` values); they describe the request, never a secret. */
    public readonly jiraMessages: readonly string[] = [],
  ) {
    super(`Jira rejected the request (${status})`, status === 404 ? 'NOT_FOUND' : 'REJECTED', false);
  }
}

/** The request was refused locally, before any call (for example, a summary longer than Jira allows). */
export class JiraValidationError extends JiraError {
  constructor(
    public readonly field: string,
    why: string,
  ) {
    super(`Invalid ${field}: ${why}`, 'INVALID_INPUT', false);
  }
}

/** A well-formed answer carried a value this system does not model (for example, an unknown hierarchy level). */
export class JiraProtocolError extends JiraError {
  constructor(what: string) {
    super(`Unexpected Jira data: ${what}`, 'UNSUPPORTED_DATA', false);
  }
}
