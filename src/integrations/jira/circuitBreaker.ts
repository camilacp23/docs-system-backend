/**
 * Circuit breaker of the Jira client (SDD Table 60, D-45): after `failureThreshold` consecutive failures it opens for
 * `openMs`; calls then fail at once. When the time is over, ONE trial call decides: success closes it, failure opens
 * it again. The state is derived from the clock, so there is no timer to leak and tests drive it with a fake `now`.
 *
 * @module integrations/jira/circuitBreaker
 */
import { JiraCircuitOpenError } from './errors.js';
import type { JiraBreakerState } from './types.js';

export type CircuitBreakerOptions = {
  /** Consecutive failures that open the circuit (Table 60: 5). */
  failureThreshold: number;
  /** Time the circuit stays open (Table 60: 60 s). */
  openMs: number;
  now: () => number;
};

/** Breaker for one Jira site. Single-threaded: Node runs the methods without interleaving. */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private probeInFlight = false;

  constructor(private readonly options: CircuitBreakerOptions) {}

  /** Current state: `open` for `openMs` after the circuit opened, then `half-open` until a trial call ends. */
  state(): JiraBreakerState {
    if (this.openedAt === null) return 'closed';
    return this.options.now() - this.openedAt < this.options.openMs ? 'open' : 'half-open';
  }

  /**
   * Called before every call.
   *
   * @returns `probe: true` when this call is the single trial call of the half-open state.
   * @throws {JiraCircuitOpenError} While open, or while the trial call is still in flight.
   */
  acquire(): { probe: boolean } {
    const state = this.state();
    if (state === 'closed') return { probe: false };
    if (state === 'half-open' && !this.probeInFlight) {
      this.probeInFlight = true;
      return { probe: true };
    }
    const elapsed = this.openedAt === null ? 0 : this.options.now() - this.openedAt;
    throw new JiraCircuitOpenError(Math.max(0, this.options.openMs - elapsed));
  }

  /**
   * Records the outcome of a call that {@link acquire} let through.
   *
   * @param ok - False only for failures of availability; an answer from Jira (even a 404) is ok.
   * @param probe - The value returned by `acquire`.
   * @returns The transition caused by this outcome, or null.
   */
  record(ok: boolean, probe: boolean): 'opened' | 'closed' | null {
    if (probe) this.probeInFlight = false;
    // A call that started before the circuit opened and ends now says nothing about the trial: only the probe decides.
    if (!probe && this.openedAt !== null) return null;
    if (ok) {
      const wasOpen = this.openedAt !== null;
      this.failures = 0;
      this.openedAt = null;
      return wasOpen ? 'closed' : null;
    }
    this.failures += 1;
    if (probe || this.failures >= this.options.failureThreshold) {
      const transition = this.openedAt === null ? 'opened' : null;
      this.openedAt = this.options.now();
      return probe ? 'opened' : transition;
    }
    return null;
  }
}
