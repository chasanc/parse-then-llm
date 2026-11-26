---
status: accepted
date: 2026-11-25
decision: Parse deterministically first; call the LLM only when the parser is unsure or its arithmetic fails.
considered:
  - Deterministic parser first, LLM as fallback (chosen)
  - LLM for every document
  - LLM first, deterministic parser to validate its answer
rejected:
  - LLM for every document
  - LLM first, deterministic parser to validate its answer
---

# 0001. Two tiers: deterministic before LLM

## Context

Most invoices from a given generator have a clean text layer. A parser reads those in milliseconds, for free,
and gives the same answer every time. Scans, prose layouts and odd tables defeat it. An LLM handles those but
costs money per page, adds seconds of latency, can be wrong in ways that read as plausible, and sends the
document to a third party.

## Decision

Tier 1 runs on every document. It escalates to Tier 2 only when `coverageScore` is below
`COVERAGE_THRESHOLD` or an arithmetic invariant fails (quantity × unit price = amount, line items sum to total).

Tier 2 output goes through the same invariant checks. A result that fails them is `needs_review`, never
`ai_enhanced`. Tier 2 can only fill gaps: ADR 0003 stops it overwriting a verified Tier 1 value.

The offline eval reports the Tier 1 resolution rate and the Tier 2 escalation rate, so a parser regression shows
up as cost.

## Why not the alternatives

- **LLM for every document:** pays for the easy majority, and a model error on a clean PDF is a regression the
  parser would not have made.
- **LLM first, parser to validate:** the parser has to be written either way; running it second keeps the cost.

## Phase gate

Tier 1 ships on its own. With no Tier 2 worker configured, escalated jobs end `failed` with the Tier 1 result
kept as `needs_review`. Turning Tier 2 on is a deliberate step: see `docs/runbooks/llm-go-live-checklist.md`.

## Consequences

- Escalation quality depends on the invariants; a wrong value that still sums correctly passes Tier 1.
- The threshold is a cost/accuracy knob. Tune it with the eval, not by feel.
