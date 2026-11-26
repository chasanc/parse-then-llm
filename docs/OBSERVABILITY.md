# Observability

## What exists today

The runner writes one JSON line per job event through the Nest logger (`runner` context):

| Event | Meaning | Fields |
|---|---|---|
| `job.done` | Job finished | `jobId, documentId, tier, attempts` |
| `job.escalated` | Tier 1 asked for review; Tier 2 queued | same |
| `job.retry` | Transient failure; rescheduled with backoff | + `error`, `delayMs` |
| `job.circuit_open` | Breaker open for that tier; parked, no attempt spent | + `retryAfterMs` |
| `job.failed` | Terminal error or attempts exhausted | + `transient`, `error` |

The extractions service logs `result.stale_dropped` (`documentId, tier`, context `extractions`) when a worker's
result is discarded because the document was replaced while it ran. A few after a replace are normal; a steady
stream means something is re-uploading documents under live jobs.

Job state is queryable at `GET /jobs/:id` (`status`, `attempts`, `tierDone`, `lastError`). The runbooks use SQL on
the `jobs` table for the same facts.

Not built: trace propagation (the last section is the design).

## Metrics

`GET /metrics` (Prometheus text, same `Authorization: Bearer $PTL_API_KEY` as the public API; configure the
scraper's bearer credentials).

| Metric | Type | Labels | Source |
|---|---|---|---|
| `jobs` | gauge | `status` = pending, running, done, failed | database |
| `job_oldest_age_seconds` | gauge | `status` = pending, running | database |
| `extractions_needs_review` | gauge | | database (the reviewer queue size) |
| `llm_tokens_total` | counter | `direction` = input, output | `extraction_runs`, survives restarts |
| `tier2_results_last_day` | gauge | | `extraction_runs` (what `MAX_TIER2_PER_DAY` compares with) |
| `runner_events_total` | counter | `event`, `tier` | in-process, resets on restart (use `rate()`/`increase()`) |
| `circuit_open` | gauge | `tier` | in-process breaker |

Not exported: per-request extractor latency (`extractor_request_seconds`); add a histogram when you need it.
Alert on `job_oldest_age_seconds` as in `runbooks/stuck-jobs.md`, and on `extractions_needs_review` growing.

## Tracing (target)

One trace should span `POST /jobs → queue → runner → extractor → callback`. Two layers, because the queue is a
database row, not an HTTP call:

1. **HTTP hops:** send W3C `traceparent` on the runner's POST to the extractor, and on the extractor's callbacks
   to the API.
2. **Queue hop:** store the caller's `traceparent` in a `trace` column on `jobs` at enqueue. The runner reads it
   when it claims the job and continues the same trace. It is optional; a job without it starts a new trace.

Until then, correlate by `documentId` and `jobId`, which every runner log line carries.
