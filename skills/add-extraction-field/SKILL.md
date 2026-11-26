---
name: add-extraction-field
description: Add a new invoice field (for example `dueDate`) to the extraction pipeline. Use when a field must be added, renamed or removed. The field list lives in six places that must change together.
---

# Add an extraction field

The field list is repeated on purpose: each tier deploys separately. Missing one place fails quietly, so change
all of them in one commit.

## Domain rules

| Kind of value | Rule |
|---|---|
| Money | Integer minor units (cents). Never floats. |
| Dates | ISO `YYYY-MM-DD` strings. |
| Absent | `null`, blank string, `0`, `NaN` or `[]` all count as absent (ADR 0003) and never overwrite a present value. |
| Currency | ISO 4217 code, uppercase. |
| Invariants | If the new field takes part in arithmetic, add it to Tier 1's invariant check and Tier 2's `clean()`. |

## Checklist (in this order)

1. **Contract:** `spec/extraction.yaml`: add the property under `Extraction` and to its `required` list.
2. **Merge rule:** `apps/api/src/common/merge.ts`: add to `FIELDS`. `coverageScore` is the fraction of fields
   present, so adding one changes every coverage value and the Tier 1 threshold behaviour.
3. **Tier 1:** `services/extractor-deterministic/parse.py`: parse it and report it in the payload.
4. **Tier 2:** `services/extractor-llm/providers.py`: add it to `SCHEMA` and `PROMPT`. `llm.py`: validate it in
   `clean()` (a bad value becomes `null`, not a crash).
5. **Fixtures:** `eval/generate_fixtures.py`: put the field on the generated PDFs and in the expected JSON
   (`eval/fixtures/expected/*.json`). Regenerate. Include at least one fixture where the field is missing.
6. **Eval:** `eval/run_eval.py`: add to `FIELDS`.

## Verify

```
npm test -w @parse-then-llm/api
uv run --directory services/extractor-deterministic pytest -q
uv run --directory services/extractor-llm pytest -q
docker compose up -d --build && eval/run_eval.py
```

The eval must end at 100% field accuracy with the mock provider. If Tier 1 now escalates documents it used to
resolve, the parser misses the new field: fix the parser, do not lower `COVERAGE_THRESHOLD`.

Do not edit an applied migration. The merged result is stored as JSON, so a new field needs no migration.
