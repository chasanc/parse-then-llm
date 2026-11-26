-- Runner state. A job is claimed by leasing it; a crashed worker's lease simply expires.
ALTER TABLE jobs
  ADD COLUMN tier_done       smallint    NOT NULL DEFAULT 0 CHECK (tier_done IN (0, 1, 2)),
  ADD COLUMN attempts        integer     NOT NULL DEFAULT 0, -- claims since the last tier succeeded
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN lease_until     timestamptz,
  ADD COLUMN last_error      text;

CREATE INDEX jobs_due ON jobs (next_attempt_at) WHERE status IN ('pending', 'running');
