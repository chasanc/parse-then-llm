import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { Db } from '../db/db';

@Injectable()
export class DocumentsService {
  private readonly maxBytes = Number(process.env.MAX_DOCUMENT_BYTES ?? 20 * 1024 * 1024);
  private readonly dir = path.resolve(process.env.DOCUMENTS_DIR ?? './data/documents');

  constructor(@Inject(Db) private readonly db: Db) {
    mkdirSync(this.dir, { recursive: true });
  }

  private file(sha256: string) {
    return path.join(this.dir, `${sha256}.pdf`);
  }

  /** Stream the body to disk while hashing, so a large upload never sits in memory. */
  async save(documentId: string, body: Readable, replace = false) {
    const tmp = path.join(this.dir, `.upload-${randomBytes(8).toString('hex')}`);
    const hash = createHash('sha256');
    let size = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        const out = createWriteStream(tmp);
        body.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > this.maxBytes) {
            body.unpipe(out); // stop writing; the rest of the upload is discarded, not stored
            out.destroy();
            body.resume();
            return reject(new PayloadTooLargeException());
          }
          hash.update(chunk);
        });
        body.on('error', reject);
        out.on('error', reject);
        out.on('finish', resolve);
        body.pipe(out);
      });
      if (size === 0) throw new BadRequestException('empty body');
      const fh = await open(tmp, 'r');
      const head = Buffer.alloc(5);
      await fh.read(head, 0, 5, 0);
      await fh.close();
      if (head.toString('latin1') !== '%PDF-') throw new BadRequestException('not a PDF');

      const sha256 = hash.digest('hex');
      const previous = await this.commit(documentId, sha256, size, tmp, replace);
      // The replaced file is garbage once no document points at it (content-addressed: another id may share it).
      // shortcut: the check and the delete are not atomic with a concurrent upload of the same bytes under another id;
      // that window is milliseconds wide. Make it a locked delete if uploads become heavy.
      if (previous && previous !== sha256) {
        const { rowCount } = await this.db.pool.query('SELECT 1 FROM documents WHERE sha256 = $1', [previous]);
        if (!rowCount) await rm(this.file(previous), { force: true });
      }
      return { documentId, sha256, sizeBytes: size };
    } finally {
      await rm(tmp, { force: true });
    }
  }

  /** One transaction: conflict check, file, row and stale result change together. Returns the previous sha256, if any. */
  private async commit(documentId: string, sha256: string, size: number, tmp: string, replace: boolean) {
    const client = await this.db.pool.connect();
    try {
      await client.query('BEGIN');
      // Same lock key as the extraction callbacks, so a replace and a landing result cannot interleave.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [documentId]);
      const prev = (await client.query('SELECT sha256 FROM documents WHERE document_id = $1', [documentId])).rows[0]?.sha256 as string | undefined;
      const changed = !!prev && prev !== sha256;
      // Different bytes for an id that already has a result would leave that result describing a file that is gone.
      if (changed && !replace && (await client.query('SELECT 1 FROM extractions WHERE document_id = $1', [documentId])).rowCount) {
        throw new ConflictException('document already extracted; send ?replace=true to replace it');
      }
      await rename(tmp, this.file(sha256)); // same content, same path: re-uploads are harmless
      await client.query(
        `INSERT INTO documents (document_id, sha256, size_bytes) VALUES ($1, $2, $3)
         ON CONFLICT (document_id) DO UPDATE SET sha256 = $2, size_bytes = $3`,
        [documentId, sha256, size],
      );
      // The old result no longer matches the bytes (or, with ?replace=true, the caller wants a fresh run); drop it so it
      // is not served as current. extraction_runs keeps history.
      if (changed || replace) await client.query('DELETE FROM extractions WHERE document_id = $1', [documentId]);
      await client.query('COMMIT');
      return prev;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async open(documentId: string) {
    const { rows } = await this.db.pool.query('SELECT sha256, size_bytes FROM documents WHERE document_id = $1', [documentId]);
    if (!rows[0] || !existsSync(this.file(rows[0].sha256))) throw new NotFoundException();
    return { stream: createReadStream(this.file(rows[0].sha256)), size: rows[0].size_bytes as number, sha256: rows[0].sha256 as string };
  }
}
