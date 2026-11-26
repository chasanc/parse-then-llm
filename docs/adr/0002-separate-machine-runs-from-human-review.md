---
status: accepted
date: 2026-11-25
decision: Keep machine output in immutable extraction_runs and human decisions in a separate document_review_context.
considered:
  - Immutable machine runs plus a separate human review table (chosen)
  - One mutable row per document that both machines and people edit
  - Version every edit in a single history table
rejected:
  - One mutable row per document that both machines and people edit
  - Version every edit in a single history table
---

# 0002. Machine runs and human review live apart

## Context

Parsers and prompts change. Re-running a document must be safe. If a person has corrected a total, a re-run must
not silently put the machine's value back.

## Decision

- `extraction_runs` records every tier callback exactly as received. A trigger rejects UPDATE and DELETE.
- `extractions` is the merged current result, rebuilt from machine output (ADR 0003).
- `document_review_context` holds approvals and manual corrections. No extractor writes to it, so no re-run can
  touch it. A reader applies `corrections` over the merged result.

## Why not the alternatives

- **One mutable row:** a re-run and a reviewer race, and the loser's work vanishes without a trace.
- **One history table:** "who wins" then has to be decided on read for every field. Splitting by author makes the
  rule simple: people beat machines.

## Consequences

- The table exists (migration 004) but nothing writes or reads it yet; the review API is not built.
- `extractions` can be thrown away and rebuilt by replaying `extraction_runs`. That replay is not written yet.
