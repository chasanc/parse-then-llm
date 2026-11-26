-- Uploaded PDFs. The bytes live on disk under DOCUMENTS_DIR, named by sha256 (content-addressed).
CREATE TABLE documents (
  document_id text PRIMARY KEY,
  sha256      text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes  integer NOT NULL CHECK (size_bytes > 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);
