/** Request fields set by the authentication chain (src/security/middleware.ts). */
declare namespace Express {
  interface Request {
    /** Current role and status, read from the database on every request (D-25). */
    user?: { id: number; role: string; status: string };
    /** Contract policy (x-roles / x-rule) of the matched operation, set by `authorize`. */
    policy?: import('../security/rbac.js').OperationPolicy;
  }
}
