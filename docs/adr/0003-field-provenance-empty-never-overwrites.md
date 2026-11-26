---
status: accepted
date: 2026-11-25
decision: One precedence chain, structured then pdf then llm, where empty never overwrites.
considered:
  - Single precedence chain with an isPresent gate (chosen)
  - Last writer wins
  - Per-field confidence scores
rejected:
  - Last writer wins
  - Per-field confidence scores
---

# 0003. Field provenance: empty never overwrites

## Context

Tier 1 (deterministic parser) and Tier 2 (LLM) both report the same invoice
fields. Tier 2 can return blank strings, `null` or `0` for fields it could not
read. If those replaced a verified Tier 1 value, escalation would lose data.

## Decision

For each field, take the first present value in the order `structured`, `pdf`,
`llm`, and record which source supplied it in `fieldSources`.

A value is absent if it is `null`, `undefined`, a blank string, `0`, `NaN` or an
empty array.

The rule lives in one place, `apps/api/src/common/merge.ts`. Each tier callback
runs in a transaction that holds a per-document advisory lock, merges the
incoming payload with the stored result using that code, then upserts. The
database does not re-implement the rule in SQL, so the two cannot drift. Within
one source, the newer payload replaces the older one; across sources, precedence
decides.

`status` is derived from the merged result (`deriveStatus`), not copied from the
payload an extractor posts.

## Consequences

- A blank Tier 2 value can never clobber a Tier 1 value.
- `0` is absent for every field. In practice only `total` is a top-level
  number, so an invoice whose real total is zero ends up `needs_review` rather
  than `verified`. Accepted: zero-value invoices are not in scope.
- Provenance is per field, not per document, so one result can mix sources.

## Rejected options

- **Last writer wins:** simplest, but a flaky LLM response erases good data.
- **Per-field confidence scores:** LLM self-reported confidence is not
  calibrated, and the extra moving part buys nothing over a fixed order.
