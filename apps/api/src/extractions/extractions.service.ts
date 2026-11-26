import { Inject, Injectable, Logger } from '@nestjs/common';
import { Candidates, coverage, deriveStatus, Field, FIELDS, InvoiceFields, isPresent, mergeFields, Source } from '../common/merge';
import { Db } from '../db/db';
import type { Payload } from './schema.validator';

function addCandidates(into: Candidates, fields: Partial<InvoiceFields>, sourceOf: (f: Field) => Source) {
  for (const f of FIELDS) {
    if (isPresent(fields[f])) ((into[sourceOf(f)] ??= {}) as Record<string, unknown>)[f] = fields[f];
  }
}

@Injectable()
export class ExtractionsService {
  private readonly log = new Logger('extractions');

  constructor(@Inject(Db) private readonly db: Db) {}

  /** The current merged result, in the shape of the contract. */
  async get(documentId: string) {
    const res = await this.db.pool.query(
      `SELECT extraction_tier, coverage_score, status, field_sources, fields FROM extractions WHERE document_id = $1`,
      [documentId],
    );
    const r = res.rows[0];
    if (!r) return undefined;
    return {
      documentId,
      extractionTier: r.extraction_tier,
      coverageScore: Number(r.coverage_score),
      fieldSources: r.field_sources,
      status: r.status,
      ...r.fields,
    };
  }

  /** Reviewer queue: results in one status, oldest first so nothing waits forever. Ids only; fetch each for the fields. */
  async list(status: string, limit: number, after?: string) {
    const { rows } = await this.db.pool.query(
      `SELECT document_id AS "documentId", extraction_tier AS "extractionTier", coverage_score AS "coverageScore", status, updated_at AS "updatedAt"
       FROM extractions WHERE status = $1 AND ($3::text IS NULL OR (updated_at, document_id) > (SELECT updated_at, document_id FROM extractions WHERE document_id = $3))
       ORDER BY updated_at, document_id LIMIT $2`,
      [status, limit, after ?? null],
    );
    return rows.map((r) => ({ ...r, coverageScore: Number(r.coverageScore) }));
  }

  /** `readSha256` is the hash of the bytes the worker read; a result for bytes that were replaced meanwhile is dropped. */
  async apply(tier: 1 | 2, p: Payload, readSha256?: string): Promise<void> {
    const client = await this.db.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize callbacks per document so two tiers landing together merge one after the other.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [p.documentId]);
      if (readSha256) {
        const current = (await client.query('SELECT sha256 FROM documents WHERE document_id = $1', [p.documentId])).rows[0]?.sha256;
        if (current !== readSha256) {
          // The job stays as it is: a job for the new bytes (or a retry of this one) reads the current file.
          this.log.warn(JSON.stringify({ event: 'result.stale_dropped', documentId: p.documentId, tier }));
          await client.query('ROLLBACK');
          return;
        }
      }
      await client.query('INSERT INTO extraction_runs (document_id, tier, payload) VALUES ($1, $2, $3)', [
        p.documentId,
        tier,
        p,
      ]);

      const prev = (
        await client.query('SELECT extraction_tier, fields, field_sources FROM extractions WHERE document_id = $1', [
          p.documentId,
        ])
      ).rows[0];
      const candidates: Candidates = {};
      if (prev) addCandidates(candidates, prev.fields, (f) => prev.field_sources[f]);
      // Tier 2 is always `llm`; tier 1 may report `structured`, defaulting to `pdf`.
      addCandidates(candidates, p, (f) => (tier === 2 ? 'llm' : (p.fieldSources[f] ?? 'pdf')));

      const { fields, fieldSources } = mergeFields(candidates);
      const status = deriveStatus(fields, fieldSources);
      await client.query(
        `INSERT INTO extractions (document_id, extraction_tier, coverage_score, status, field_sources, fields)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (document_id) DO UPDATE SET
           extraction_tier = EXCLUDED.extraction_tier, coverage_score = EXCLUDED.coverage_score,
           status = EXCLUDED.status, field_sources = EXCLUDED.field_sources, fields = EXCLUDED.fields,
           updated_at = now()`,
        [
          p.documentId,
          Math.max(tier, prev?.extraction_tier ?? 0),
          coverage(fields),
          status,
          fieldSources,
          fields,
        ],
      );

      // The stored status above is always derived; the status an extractor posts is never stored. It is read only to
      // steer the job: Tier 1 may flag its own doubt (for example a sum check that failed on a result that otherwise
      // looks complete) and that sends the job on to tier 2. Tier 1 saying "verified" cannot end the job on its own,
      // and 'failed' from tier 1 (a corrupt file) stays terminal: there is nothing for tier 2 to read.
      const good = status === 'verified' || status === 'ai_enhanced';
      const escalate = tier === 1 && !good && (status === 'needs_review' || p.status === 'needs_review');
      if (!escalate) {
        await client.query(
          `UPDATE jobs SET status = 'done', updated_at = now()
           WHERE document_id = $1 AND status IN ('pending', 'running')`,
          [p.documentId],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
