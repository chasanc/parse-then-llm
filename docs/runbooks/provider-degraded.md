# Runbook: LLM provider degraded

| Tier | Condition | Action |
|---|---|---|
| **Page** | Tier 2 circuit open for more than 10 minutes, or failure rate above 50% over at least 20 calls | Follow this runbook |
| **Ticket** | Silent zero-field output, or jobs parked at the retry cap | Investigate within a day |

Tier 1 is unaffected. Documents that Tier 1 resolves keep flowing; only escalated ones wait.

Tier 2 makes one model call per attempt (60 s timeout, no SDK retries), so a degraded provider shows up as runner
retries with backoff, each counted in `attempts`, never as hidden extra calls.

Check all three signals. Any one alone misleads: an open circuit says the provider is failing *loudly*, but a
provider can also answer 200 with nothing in it.

## 1. Failure rate, with a sample floor

A rate over three calls is noise. Look only when the sample is big enough:

```sql
SELECT count(*) FILTER (WHERE status = 'failed') AS failed, count(*) AS total,
       round(100.0 * count(*) FILTER (WHERE status = 'failed') / nullif(count(*), 0)) AS pct
FROM jobs
WHERE tier_done = 1 AND status IN ('done', 'failed') AND updated_at > now() - interval '30 minutes'
HAVING count(*) >= 20;
```

No row means too few jobs to say anything.

## 2. Silent zero-field output

The call succeeds, the circuit stays closed, and every field comes back empty. This is the one the breaker
cannot see.

```sql
SELECT count(*) AS empty_tier2
FROM extraction_runs
WHERE tier = 2 AND created_at > now() - interval '1 hour'
  AND payload->>'vendor' IS NULL AND payload->>'invoiceNumber' IS NULL AND payload->>'total' IS NULL;
```

Compare with the normal rate. Real blank documents exist (`empty-01` in the fixtures), so a few are expected; a
jump is not.

## 3. Parked backlog

```sql
SELECT count(*), min(created_at) FROM jobs
WHERE status = 'pending' AND tier_done = 1 AND last_error = 'circuit open';

SELECT count(*) AS at_cap FROM jobs
WHERE status = 'failed' AND tier_done = 1 AND updated_at > now() - interval '1 day';
```

Parked jobs spend no attempts, so they resume by themselves once the breaker closes. Jobs `failed` at the cap
need re-enqueueing (see `stuck-jobs.md`).

## Act

1. Open the extractor's logs for Tier 2 and read the provider's error (auth, quota, 5xx, timeout).
2. Check the provider's status page. If it is an outage, wait; the breaker probes after `BREAKER_COOLDOWN_MS`.
3. If it is our key or quota, fix that. Do not raise `CONCURRENCY` to push through a 429.
4. To stop paying for a bad model while you investigate, stop the `extractor-llm` container. Do not switch to
   `LLM_PROVIDER=mock`: it replays the answer key and would write fixture data into real documents. Escalated
   jobs retry, then park once the breaker opens.
5. After recovery, re-enqueue the jobs from step 3.
