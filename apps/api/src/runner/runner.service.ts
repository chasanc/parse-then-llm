import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Db } from '../db/db';
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker';
import { ExtractorError, Extractors } from './extractors';

export interface Claimed {
  id: string;
  documentId: string;
  tierDone: number;
  attempts: number;
}

/** shortcut: no jitter. With one API instance retries cannot stampede; add jitter before running several. */
export function backoffMs(attempts: number, baseMs: number, capMs: number): number {
  return Math.min(capMs, baseMs * 2 ** Math.max(0, attempts - 1));
}

const num = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

/**
 * Claims due jobs by lease, runs the next tier for each with bounded concurrency, and reschedules failures.
 * The same claim query serves new jobs, backed-off retries and jobs whose worker died (lease expired),
 * so there is no separate sweeper to keep in sync.
 */
@Injectable()
export class RunnerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('runner');
  readonly cfg = {
    concurrency: num('CONCURRENCY', 4),
    leaseSeconds: num('LEASE_SECONDS', 180), // must outlast EXTRACTOR_TIMEOUT_MS
    maxAttempts: num('MAX_ATTEMPTS', 5),
    backoffBaseMs: num('BACKOFF_BASE_MS', 5_000),
    backoffCapMs: num('BACKOFF_CAP_MS', 300_000),
    intervalMs: num('RUNNER_INTERVAL_MS', 1_000),
    maxTier2PerDay: Number(process.env.MAX_TIER2_PER_DAY) || 0, // 0 or unset: no cap
  };
  /** In-process counters for /metrics, keyed "event|tier". They reset when the API restarts. */
  readonly events = new Map<string, number>();
  readonly breakers = {
    1: new CircuitBreaker(num('BREAKER_THRESHOLD', 5), num('BREAKER_COOLDOWN_MS', 30_000)),
    2: new CircuitBreaker(num('BREAKER_THRESHOLD', 5), num('BREAKER_COOLDOWN_MS', 30_000)),
  };
  private inFlight = 0;
  private claiming = false;
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Extractors) private readonly extractors: Extractors,
  ) {}

  onApplicationBootstrap() {
    if (process.env.RUNNER_ENABLED === 'false') return;
    this.timer = setInterval(() => void this.tick().catch((e) => this.log.error(`tick failed: ${e.message}`)), this.cfg.intervalMs);
  }

  onApplicationShutdown() {
    clearInterval(this.timer); // in-flight work is not awaited: its lease expires and the job is picked up again
  }

  /** Claim up to the free capacity and start the jobs. Resolves when this batch is finished. */
  async tick(): Promise<void> {
    if (this.claiming) return;
    this.claiming = true;
    let batch: Claimed[];
    try {
      const room = this.cfg.concurrency - this.inFlight;
      if (room <= 0) return;
      batch = await this.claim(room);
      this.inFlight += batch.length;
    } finally {
      this.claiming = false;
    }
    await Promise.all(
      batch.map((job) =>
        this.process(job)
          .catch((e) => this.log.error(`job ${job.id} crashed: ${e.message}`)) // lease expiry will retry it
          .finally(() => this.inFlight--),
      ),
    );
  }

  async claim(limit: number): Promise<Claimed[]> {
    const { rows } = await this.db.pool.query(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = now(),
                       lease_until = now() + make_interval(secs => $2)
       WHERE id IN (
         SELECT id FROM jobs
         WHERE (status = 'pending' AND next_attempt_at <= now()) OR (status = 'running' AND lease_until < now())
         ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
       RETURNING id, document_id AS "documentId", tier_done AS "tierDone", attempts`,
      [limit, this.cfg.leaseSeconds],
    );
    return rows;
  }

  async process(job: Claimed): Promise<void> {
    const tier = (job.tierDone + 1) as 1 | 2;
    const event = { jobId: job.id, documentId: job.documentId, tier, attempts: job.attempts };
    // A job whose worker keeps dying is re-claimed on lease expiry and never reaches the failure path below.
    if (job.attempts > this.cfg.maxAttempts) {
      this.note('error', event, 'job.failed', { error: 'attempts exhausted' });
      return this.fail(job, 'attempts exhausted');
    }
    if (tier === 2 && this.cfg.maxTier2PerDay && (await this.tier2RunsLastDay()) >= this.cfg.maxTier2PerDay) {
      // The Tier 1 result stays as it is (usually needs_review): a person reads it instead of the model.
      this.note('error', event, 'job.failed', { transient: false, error: 'daily tier 2 cap reached' });
      return this.fail(job, 'daily tier 2 cap reached');
    }
    try {
      await this.breakers[tier].run(
        () => this.extractors.run(tier, job.documentId),
        (e) => !(e instanceof ExtractorError && !e.transient),
      );
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        // The upstream is down, not this job: wait out the cooldown without spending one of its attempts.
        this.note('warn', event, 'job.circuit_open', { retryAfterMs: err.retryAfterMs });
        return this.reschedule(job, err.retryAfterMs, 'circuit open', job.attempts - 1);
      }
      const transient = err instanceof ExtractorError ? err.transient : true;
      const message = (err as Error).message;
      return this.retryOrFail(job, message, transient, event);
    }

    // The worker answered 2xx, so its result was posted to the callback, which finishes the job when it is complete.
    const { rows } = await this.db.pool.query('SELECT status FROM jobs WHERE id = $1', [job.id]);
    if (rows[0]?.status === 'done') return this.note('log', event, 'job.done');
    if (tier === 1) {
      // Tier 1 asked for review: go straight on to tier 2, with a fresh attempt budget.
      this.note('log', event, 'job.escalated');
      return this.escalate(job);
    }
    // Tier 2 answered but no result arrived: treat it like any other transient failure.
    return this.retryOrFail(job, 'tier 2 returned without posting a result', true, event);
  }

  /** Fail at once for a terminal error or an exhausted budget; otherwise back off and try again. */
  private async retryOrFail(job: Claimed, message: string, transient: boolean, event: { tier: number }) {
    if (!transient || job.attempts >= this.cfg.maxAttempts) {
      this.note('error', event, 'job.failed', { transient, error: message });
      return this.fail(job, message);
    }
    const delayMs = backoffMs(job.attempts, this.cfg.backoffBaseMs, this.cfg.backoffCapMs);
    this.note('warn', event, 'job.retry', { delayMs, error: message });
    return this.reschedule(job, delayMs, message, job.attempts);
  }

  /** One JSON log line, and a counter for /metrics. */
  private note(level: 'log' | 'warn' | 'error', base: { tier: number }, name: string, extra: object = {}) {
    this.log[level](JSON.stringify({ ...base, event: name, ...extra }));
    const key = `${name}|${base.tier}`;
    this.events.set(key, (this.events.get(key) ?? 0) + 1);
  }

  /** Counts finished Tier 2 results (the callback writes them), so calls still in flight can overshoot the cap by up to CONCURRENCY. */
  async tier2RunsLastDay(): Promise<number> {
    const { rows } = await this.db.pool.query(
      `SELECT count(*)::int AS n FROM extraction_runs WHERE tier = 2 AND created_at > now() - interval '1 day'`,
    );
    return rows[0].n;
  }

  private async reschedule(job: Claimed, delayMs: number, error: string, attempts: number) {
    await this.db.pool.query(
      `UPDATE jobs SET status = 'pending', attempts = $2, last_error = $3, lease_until = NULL, updated_at = now(),
                       next_attempt_at = now() + make_interval(secs => $4)
       WHERE id = $1 AND status = 'running'`,
      [job.id, Math.max(0, attempts), error, delayMs / 1000],
    );
  }

  private async escalate(job: Claimed) {
    await this.db.pool.query(
      `UPDATE jobs SET status = 'pending', tier_done = 1, attempts = 0, next_attempt_at = now(),
                       lease_until = NULL, last_error = NULL, updated_at = now()
       WHERE id = $1 AND status = 'running'`,
      [job.id],
    );
  }

  private async fail(job: Claimed, error: string) {
    await this.db.pool.query(
      `UPDATE jobs SET status = 'failed', last_error = $2, lease_until = NULL, updated_at = now()
       WHERE id = $1 AND status = 'running'`,
      [job.id, error],
    );
  }
}
