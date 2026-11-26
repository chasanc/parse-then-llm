export class CircuitOpenError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`circuit open, retry in ${retryAfterMs}ms`);
  }
}

/**
 * Opens after `threshold` consecutive failures and rejects calls for `cooldownMs`.
 * Then it lets one trial call through: success closes it, failure re-opens it for another cooldown.
 */
export class CircuitBreaker {
  now: () => number = Date.now; // replaceable in tests
  private failures = 0;
  private openUntil = 0;
  private trialInFlight = false;

  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
  ) {}

  get isOpen(): boolean {
    return this.now() < this.openUntil || this.trialInFlight;
  }

  /** `isFailure` says whether a thrown error means the upstream is unhealthy; a per-job error (bad input) must not count. */
  async run<T>(fn: () => Promise<T>, isFailure: (err: unknown) => boolean = () => true): Promise<T> {
    const t = this.now();
    if (t < this.openUntil) throw new CircuitOpenError(this.openUntil - t);
    const trial = this.openUntil > 0; // the cooldown has passed: this call is the trial
    if (trial) {
      if (this.trialInFlight) throw new CircuitOpenError(this.cooldownMs);
      this.trialInFlight = true;
    }
    try {
      const result = await fn();
      this.failures = 0;
      this.openUntil = 0;
      return result;
    } catch (err) {
      if (!isFailure(err)) {
        // The upstream answered; only this job was bad. Treat it as a healthy call.
        this.failures = 0;
        this.openUntil = 0;
        throw err;
      }
      this.failures++;
      if (trial || this.failures >= this.threshold) this.openUntil = this.now() + this.cooldownMs;
      throw err;
    } finally {
      if (trial) this.trialInFlight = false;
    }
  }
}
