# parse-then-llm

A two-tier invoice extraction pipeline. A deterministic parser reads every document first; an LLM is called only
when the parser is unsure or its arithmetic does not add up. All data is synthetic.

```
                 PUT /documents/:id            ┌──────────────┐
  client ──────► POST /jobs ─────────────────► │   API        │ ◄── Postgres
                 GET /jobs/:id, /extractions   │  (NestJS)    │     jobs, extraction_runs,
                                               │  runner      │     extractions
                                               └──┬────────▲──┘
                          signed POST /run        │        │  signed callbacks
                                    ┌─────────────┘        │  /internal/extractions/tier1|2
                                    ▼                      │
                     ┌─────────────────────────┐   ┌───────┴─────────────────┐
                     │ extractor-deterministic │   │ extractor-llm           │
                     │ Tier 1: PyMuPDF text    │   │ Tier 2: page images →   │
                     │ layer + arithmetic check│   │ Claude (or mock)        │
                     └─────────────────────────┘   └─────────────────────────┘
```

## Run it

```
cp .env.example .env            # then set HMAC_SECRET and PTL_API_KEY:  openssl rand -hex 32
docker compose up -d --build
export PTL_API_KEY=...            # same value as in .env; the eval script and curl below send it
eval/run_eval.py                # pushes the 12 fixture PDFs through the stack and scores them
```

`LLM_PROVIDER` defaults to `mock`, which answers from the answer key: no API key, no network. Set
`LLM_PROVIDER=claude` and `ANTHROPIC_API_KEY` to call the model (read
`docs/runbooks/llm-go-live-checklist.md` first). Secrets are read from environment variables only; compose
refuses to start without them.

Upload and enqueue by hand:

```
curl -X PUT -H "authorization: Bearer $PTL_API_KEY" -H 'content-type: application/pdf' --data-binary @eval/fixtures/pdf/clean-01.pdf localhost:3000/documents/clean-01
curl -X POST -H "authorization: Bearer $PTL_API_KEY" -H 'content-type: application/json' localhost:3000/jobs \
     -d '{"documentId":"clean-01","documentHash":"<sha256 of the file>"}'
curl -H "authorization: Bearer $PTL_API_KEY" localhost:3000/extractions/clean-01
```

Uploading different bytes for an id that already has a result returns 409; add `?replace=true` to replace it
(the old result is dropped, `extraction_runs` keeps the history). Workers send back the sha256 of the bytes they
read (`x-document-sha256`), so a result for bytes replaced meanwhile is dropped instead of stored. Two ids with
identical bytes are separate jobs; without an `idempotencyKey`, a repeat is deduplicated per id and hash.

## Why two tiers

| | Tier 1: parser | Tier 2: LLM |
|---|---|---|
| Cost | Free | Per page |
| Latency | Milliseconds | Seconds |
| Deterministic | Yes | No |
| Handles scans and prose | No | Yes |

Most documents have a clean text layer, so the cheap, repeatable path handles them. Tier 2 sees only what Tier 1
could not finish. Details: [ADR 0001](docs/adr/0001-two-tier-deterministic-before-llm.md).

## Contract and merge rules

The callback payload is defined in [`spec/extraction.yaml`](spec/extraction.yaml) (OpenAPI 3.1) and validated on
every callback. Money is integer minor units.

- **Empty never overwrites.** Each field takes the first present value in the order `structured`, `pdf`, `llm`.
  `null`, blank, `0` and `[]` are absent. `fieldSources` records who supplied each field.
  [ADR 0003](docs/adr/0003-field-provenance-empty-never-overwrites.md).
- **The API decides the status:** `verified` (parser, invariants hold), `ai_enhanced` (LLM, invariants hold),
  `needs_review` (invariants still fail), `failed` (nothing readable).
- **Machine runs are immutable;** human decisions live in a separate table.
  [ADR 0002](docs/adr/0002-separate-machine-runs-from-human-review.md).
- **Callbacks and `/run` are HMAC-signed** (SHA-256 over the raw body; over the URL path for a body-less GET).
  The public upload, job and read endpoints take `Authorization: Bearer $PTL_API_KEY`.

## Runner

One loop in the API claims due jobs with a lease (`FOR UPDATE SKIP LOCKED`), at most `CONCURRENCY` at a time. The
same loop handles new jobs, retries and jobs whose worker died.

- Transient errors (network, 5xx, 408, 429) retry with exponential backoff up to `MAX_ATTEMPTS`. A 404 or other
  4xx fails at once.
- A circuit breaker per tier parks jobs without spending attempts while a provider is failing.
- Duplicate work is blocked by a unique index on active jobs per document id and hash, or per idempotency key.

## Eval

`eval/run_eval.py` runs against the live stack and exits non-zero on a wrong field or status, so CI gates on it.
Sample output (mock provider):

| Metric | Value |
|---|---|
| Documents | 12 |
| Resolved at Tier 1 (verified) | 42% |
| Escalated to Tier 2 | 50% |
| Field accuracy | 100.0% (72/72) |
| Status matches expected | 12/12 |

With the mock, Tier 2 answers are the answer key, so this checks Tier 1 and the plumbing, not the model. Run it
with `LLM_PROVIDER=claude` to measure the model.

## Tests

```
docker compose up -d postgres                       # tests use :5440 and make throwaway databases
npm test -w @parse-then-llm/api
uv run --directory services/extractor-deterministic pytest -q
uv run --directory services/extractor-llm pytest -q
```

CI (`.github/workflows/ci.yml`) runs typecheck, all three suites and the offline eval.

## More

[Observability](docs/OBSERVABILITY.md) · [Runbooks](docs/runbooks/) · [ADRs](docs/adr/)

## Known limits

One shared API key for all clients (no per-client revocation); HMAC has no replay protection; trace
propagation in `docs/OBSERVABILITY.md` is a design, not code; no automatic retention: documents, `extraction_runs`
and logs are kept until you purge them (see the go-live checklist). A replaced document's old file is deleted once no
document points at it. Tier 1 reads the first page only and treats a negative amount (`-$5.00`, `($5.00)`) as
unreadable, so credit notes go to review. Time budget: Tier 2 makes one 60 s model call (no SDK retries; the runner
retries with backoff), inside `EXTRACTOR_TIMEOUT_MS` (120 s), inside `LEASE_SECONDS` (180 s). Keep that order if you
change any of them, or a slow call can be paid for twice.

Operating: `GET /metrics` (Prometheus, API key), `GET /extractions?status=needs_review` (reviewer queue),
`MAX_TIER2_PER_DAY` (spend guard, off when unset). `PTL_API_KEY` must be 16+ characters: `openssl rand -hex 32`.
