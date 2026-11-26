# Checklist: turning Tier 2 on for real documents

Tier 1 ships on its own and needs none of this. Tier 2 sends document pages to a third party, so each box
below is a gate. Do not skip one because the demo worked: the default `LLM_PROVIDER=mock` answers from the
answer key and proves nothing about the model.

## Before the first real document

- [ ] **Key from a secret store.** `ANTHROPIC_API_KEY` is injected at deploy time, not baked into an image or a
      committed file. `.env` is for local development only.
- [ ] **Data retention sign-off.** Someone who owns the decision has confirmed that invoices may be sent to the
      provider and what the provider keeps. Record who and when.
- [ ] **DPA in place** if the documents contain personal data of people in a regulated region.
- [ ] **`LLM_PROVIDER=claude` and `LLM_MODEL` pinned** in the deployment, not left to the default.
- [ ] **Live eval run.** `LLM_PROVIDER=claude eval/run_eval.py` on the synthetic fixtures. Field accuracy and the
      cost line are acceptable to you; mismatch fixtures still end `needs_review`.
- [ ] **Spend cap** set on the provider account, below what a runaway loop could cost. Also set
      `MAX_TIER2_PER_DAY` on the API: past it, Tier 2 jobs fail with `daily tier 2 cap reached` and keep their
      Tier 1 result for a person. It counts finished results, so in-flight calls can overshoot by `CONCURRENCY`.
- [ ] **Alerts live** for `provider-degraded.md` and `stuck-jobs.md`, or the SQL on a schedule. `GET /metrics`
      has the series (`docs/OBSERVABILITY.md`).
- [ ] **A person reads `needs_review`.** `GET /extractions?status=needs_review` lists the queue (oldest first,
      `limit` and `after=<documentId>` to page); someone owns checking it.
- [ ] **Retention decided.** Documents (`DOCUMENTS_DIR`), `extraction_runs` payloads (full extracted fields,
      kept forever, immutable by trigger) and logs hold invoice data. Nothing deletes them automatically;
      write down how long you keep them and who purges. The provider's own retention is the sign-off above.

## Roll-out

1. Enable for a small share of traffic (a separate API instance or a document allow-list).
2. Watch the three signals in `provider-degraded.md` for a day.
3. Widen.

## Roll back

Stop the `extractor-llm` container. Escalated jobs retry, then park once the breaker opens; any that run out of
attempts end `failed` with the Tier 1 result kept as `needs_review`. No data is lost: every callback is in
`extraction_runs`.
