import { Controller, Get, Header, Inject, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from '../common/api-key.guard';
import { Db } from '../db/db';
import { RunnerService } from '../runner/runner.service';

/** Prometheus text format, hand-written: five metric families do not need a client library. */
@Controller('metrics')
@UseGuards(ApiKeyGuard) // same bearer key as the rest; point the scraper's authorization config at it
export class MetricsController {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(RunnerService) private readonly runner: RunnerService,
  ) {}

  @Get()
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(): Promise<string> {
    const out: string[] = [];
    const family = (name: string, type: 'gauge' | 'counter', help: string, samples: Array<[string, number]>) => {
      out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...samples.map(([labels, v]) => `${name}${labels} ${v}`));
    };

    const jobs = await this.db.pool.query(`SELECT status, count(*)::int AS n FROM jobs GROUP BY status`);
    const byStatus = new Map<string, number>(jobs.rows.map((r) => [r.status, r.n]));
    family('jobs', 'gauge', 'Jobs by status.', ['pending', 'running', 'done', 'failed'].map((s) => [`{status="${s}"}`, byStatus.get(s) ?? 0]));

    const age = await this.db.pool.query(
      `SELECT status, coalesce(extract(epoch FROM now() - min(updated_at)), 0)::float AS s FROM jobs WHERE status IN ('pending','running') GROUP BY status`,
    );
    const ages = new Map<string, number>(age.rows.map((r) => [r.status, r.s]));
    family('job_oldest_age_seconds', 'gauge', 'Age of the longest-waiting job in each active status.', ['pending', 'running'].map((s) => [`{status="${s}"}`, ages.get(s) ?? 0]));

    const review = await this.db.pool.query(`SELECT count(*)::int AS n FROM extractions WHERE status = 'needs_review'`);
    family('extractions_needs_review', 'gauge', 'Results waiting for a person (the reviewer queue).', [['', review.rows[0].n]]);

    const tokens = await this.db.pool.query(
      `SELECT coalesce(sum((payload->'usage'->>'inputTokens')::bigint), 0)::float AS i,
              coalesce(sum((payload->'usage'->>'outputTokens')::bigint), 0)::float AS o,
              count(*) FILTER (WHERE tier = 2 AND created_at > now() - interval '1 day')::int AS day
       FROM extraction_runs WHERE tier = 2`,
    );
    const t = tokens.rows[0];
    family('llm_tokens_total', 'counter', 'Model tokens used, from stored Tier 2 results (survives restarts).', [
      ['{direction="input"}', t.i],
      ['{direction="output"}', t.o],
    ]);
    family('tier2_results_last_day', 'gauge', 'Tier 2 results in the last 24 hours (what MAX_TIER2_PER_DAY is compared with).', [['', t.day]]);

    family(
      'runner_events_total',
      'counter',
      'Runner outcomes since this API process started.',
      [...this.runner.events].map(([key, n]) => {
        const [event, tier] = key.split('|');
        return [`{event="${event}",tier="${tier}"}`, n] as [string, number];
      }),
    );
    family(
      'circuit_open',
      'gauge',
      '1 while the breaker for a tier is rejecting calls.',
      ([1, 2] as const).map((tier) => [`{tier="${tier}"}`, this.runner.breakers[tier].isOpen ? 1 : 0] as [string, number]),
    );
    return out.join('\n') + '\n';
  }
}
