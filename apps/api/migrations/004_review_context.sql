-- Human decisions about a document (ADR 0002). Separate from extraction_runs and extractions so that
-- re-running a parser or prompt can never wipe a manual correction or approval.
-- Nothing writes here yet: the review API is out of scope for now.
CREATE TABLE document_review_context (
  document_id text PRIMARY KEY,
  reviewer    text,
  approved_at timestamptz,
  corrections jsonb NOT NULL DEFAULT '{}',  -- field name -> value a person set; wins over every tier
  notes       text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
