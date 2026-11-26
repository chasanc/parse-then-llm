import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { Db } from '../db/db';

const COLS = `id, document_id AS "documentId", status, created_at AS "createdAt"`;

export interface Job {
  id: string;
  documentId: string;
  status: string;
  createdAt: Date;
}

@Injectable()
export class JobsService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async get(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
    const res = await this.db.pool.query(
      `SELECT ${COLS}, attempts, tier_done AS "tierDone", last_error AS "lastError" FROM jobs WHERE id = $1`,
      [id],
    );
    return res.rows[0];
  }

  /** Returns the active job for this key, creating it if none exists. Safe under concurrent calls. */
  async enqueue(documentId: string, documentHash: string, dedupeKey: string): Promise<{ job: Job; created: boolean }> {
    const { pool } = this.db;
    // Retry covers the active job finishing between the failed insert and the select.
    for (let attempt = 0; attempt < 3; attempt++) {
      const inserted = await pool.query<Job>(
        `INSERT INTO jobs (document_id, document_hash, dedupe_key) VALUES ($1, $2, $3)
         ON CONFLICT (dedupe_key) WHERE status IN ('pending', 'running') DO NOTHING
         RETURNING ${COLS}`,
        [documentId, documentHash, dedupeKey],
      );
      if (inserted.rows[0]) return { job: inserted.rows[0], created: true };

      const active = await pool.query<Job>(
        `SELECT ${COLS} FROM jobs WHERE dedupe_key = $1 AND status IN ('pending', 'running')`,
        [dedupeKey],
      );
      const job = active.rows[0];
      if (job) {
        if (job.documentId !== documentId) throw new ConflictException('idempotencyKey belongs to another document');
        return { job, created: false };
      }
    }
    throw new Error('could not enqueue job');
  }
}
