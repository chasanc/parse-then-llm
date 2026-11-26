-- Job queue. One active job per dedupe_key (document hash unless the caller sent an idempotency key).
CREATE TABLE jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   text NOT NULL,
  document_hash text NOT NULL,
  dedupe_key    text NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX jobs_active_dedupe ON jobs (dedupe_key) WHERE status IN ('pending', 'running');
CREATE INDEX jobs_document_id ON jobs (document_id);

-- Every tier callback, exactly as received. Immutable (ADR 0002).
CREATE TABLE extraction_runs (
  id          bigserial PRIMARY KEY,
  document_id text NOT NULL,
  tier        smallint NOT NULL CHECK (tier IN (1, 2)),
  payload     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX extraction_runs_document_id ON extraction_runs (document_id);

CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME;
END $$;
CREATE TRIGGER extraction_runs_immutable
  BEFORE UPDATE OR DELETE ON extraction_runs
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Current merged result per document (ADR 0003).
CREATE TABLE extractions (
  document_id     text PRIMARY KEY,
  extraction_tier smallint NOT NULL CHECK (extraction_tier IN (1, 2)),
  coverage_score  numeric NOT NULL CHECK (coverage_score BETWEEN 0 AND 1),
  status          text NOT NULL CHECK (status IN ('verified', 'ai_enhanced', 'needs_review', 'failed')),
  field_sources   jsonb NOT NULL DEFAULT '{}',
  fields          jsonb NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
