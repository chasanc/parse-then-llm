# Runbook: stuck jobs

| Tier | Condition | Action |
|---|---|---|
| **Page** | A job has been `running` for more than 15 minutes, or `pending` and due for more than 30 minutes | Work through this runbook now |
| **Ticket** | `failed` jobs appear, but the backlog is moving | Read `last_error`, fix the cause, re-enqueue |

A healthy job finishes in seconds. `running` is a lease: it expires after `LEASE_SECONDS` (default 180) and the
runner reclaims the job, so a `running` job older than 15 minutes means the runner is not ticking at all.

## Find them

```sql
-- stuck > 15m
SELECT id, document_id, status, attempts, tier_done, lease_until, last_error, updated_at
FROM jobs
WHERE status = 'running' AND updated_at < now() - interval '15 minutes';

-- pending > 30m and already due
SELECT id, document_id, attempts, next_attempt_at, last_error
FROM jobs
WHERE status = 'pending' AND next_attempt_at < now() - interval '30 minutes';

-- backlog by state
SELECT status, count(*), min(created_at) AS oldest FROM jobs
WHERE status IN ('pending', 'running') GROUP BY status;
```

## Decide

| What you see | Cause | Fix |
|---|---|---|
| `running`, lease long expired, nothing claiming | API not running, or `RUNNER_ENABLED=false` | Restart the API; check the env |
| `pending`, `last_error = 'circuit open'` | Breaker open for that tier | `provider-degraded.md` |
| `pending`, `attempts` climbing, same `last_error` | Extractor down or returning 5xx | Check the extractor container and logs |
| `pending`, `next_attempt_at` in the future | Backing off; healthy | Wait. Backoff caps at `BACKOFF_CAP_MS` |
| `failed`, `tier 1 answered 404` | The document was never uploaded | Upload it, then re-enqueue |
| `failed`, `tier 2 returned without posting a result` | Tier 2 answered 200 but its callback never landed | Check the extractor's logs for the callback status |

## Recover

A `failed` job is final. Enqueue a new one for the same document; the active-job index only blocks duplicates
of jobs still `pending` or `running`:

```
POST /jobs   {"documentId": "<id>", "documentHash": "<sha256>", "idempotencyKey": "retry-1"}
```

To retry now instead of waiting out a backoff:

```sql
UPDATE jobs SET next_attempt_at = now() WHERE id = '<job id>' AND status = 'pending';
```

## Alert (target)

Needs the metrics in `docs/OBSERVABILITY.md`, which are not exported yet. Until then, run the SQL above on a
schedule.

```yaml
- alert: JobsStuck
  expr: job_oldest_age_seconds{status="pending"} > 1800 or job_oldest_age_seconds{status="running"} > 900
  for: 5m
  labels: { severity: page }
```
