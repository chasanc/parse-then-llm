import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, TestApp } from './helpers/test-app';

const pdfDir = path.resolve(__dirname, '../../../eval/fixtures/pdf');
const pdf = readFileSync(path.join(pdfDir, 'clean-01.pdf'));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(async () => {
  await t.stop();
});

const put = (id: string, body: Buffer | string) => t.http().put(`/documents/${id}`).set('content-type', 'application/pdf').send(body);
// A body-less GET is signed over its URL path.
const fetchDoc = (id: string, signature?: string) => {
  const url = `/internal/documents/${id}`;
  return t.http().get(url).set('x-signature', signature ?? t.sign(url)).buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
};

describe('upload', () => {
  it('stores a PDF and reports its hash', async () => {
    const res = await put('doc-1', pdf);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ documentId: 'doc-1', sha256: sha(pdf), sizeBytes: pdf.length });
  });

  it('accepts every fixture PDF byte for byte', async () => {
    for (const f of readdirSync(pdfDir).filter((n) => n.endsWith('.pdf') && n !== 'corrupt-01.pdf')) {
      const bytes = readFileSync(path.join(pdfDir, f));
      expect((await put(f, bytes)).body.sha256).toBe(sha(bytes));
    }
  });

  it('rejects a body that is not a PDF', async () => {
    expect((await put('bad-1', 'hello world')).status).toBe(400);
  });

  it('rejects an empty body', async () => {
    expect((await put('bad-2', '')).status).toBe(400);
  });

  it('rejects an oversize body and leaves nothing behind', async () => {
    const big = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(300_000)]);
    expect((await put('big-1', big)).status).toBe(413);
    const row = await t.pool.query(`SELECT 1 FROM documents WHERE document_id = 'big-1'`);
    expect(row.rowCount).toBe(0);
  });

  it('rejects a documentId that could escape the directory', async () => {
    expect((await put('..%2Fetc', pdf)).status).toBe(400);
  });

  it('replaces the document when the same id is uploaded again', async () => {
    const other = readFileSync(path.join(pdfDir, 'clean-02.pdf'));
    await put('doc-2', pdf);
    await put('doc-2', other);
    const row = await t.pool.query(`SELECT sha256 FROM documents WHERE document_id = 'doc-2'`);
    expect(row.rows[0].sha256).toBe(sha(other));
  });
});

describe('download for extractors', () => {
  it('returns the exact bytes with a valid signature', async () => {
    const res = await fetchDoc('doc-1');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(sha(res.body)).toBe(sha(pdf));
    expect(res.headers['x-document-sha256']).toBe(sha(pdf));
  });

  it('rejects a missing or wrong signature', async () => {
    expect((await t.http().get('/internal/documents/doc-1')).status).toBe(401);
    expect((await fetchDoc('doc-1', '0'.repeat(64))).status).toBe(401);
  });

  it('does not accept a signature made for another document', async () => {
    expect((await fetchDoc('doc-1', t.sign('/internal/documents/doc-2'))).status).toBe(401);
  });

  it('returns 404 for an unknown document', async () => {
    expect((await fetchDoc('nope')).status).toBe(404);
  });
});

describe('public API access', () => {
  it('rejects requests without the API key, or with a wrong one', async () => {
    const anon = t.anonymous();
    expect((await anon.put('/documents/auth-1').set('content-type', 'application/pdf').send(pdf)).status).toBe(401);
    expect((await anon.post('/jobs').send({})).status).toBe(401);
    expect((await anon.get('/jobs/00000000-0000-0000-0000-000000000000')).status).toBe(401);
    expect((await anon.get('/extractions/auth-1')).status).toBe(401);
    expect((await anon.get('/extractions/auth-1').set('authorization', 'Bearer wrong')).status).toBe(401);
  });
});

describe('replacing a document', () => {
  const other = Buffer.concat([pdf, Buffer.from('\n% changed')]);
  const extract = (id: string) =>
    t.pool.query(
      `INSERT INTO extractions (document_id, extraction_tier, coverage_score, status, field_sources, fields)
       VALUES ($1, 1, 1, 'verified', '{}', '{}')`,
      [id],
    );
  const hasExtraction = async (id: string) => (await t.pool.query('SELECT 1 FROM extractions WHERE document_id = $1', [id])).rowCount === 1;

  it('refuses different bytes for an id that already has a result', async () => {
    expect((await put('rep-1', pdf)).status).toBe(200);
    await extract('rep-1');
    expect((await put('rep-1', other)).status).toBe(409);
    expect(await hasExtraction('rep-1')).toBe(true);
  });

  it('allows the same bytes again, and different bytes before any result exists', async () => {
    expect((await put('rep-2', pdf)).status).toBe(200);
    expect((await put('rep-2', pdf)).status).toBe(200);
    expect((await put('rep-2', other)).status).toBe(200);
  });

  const onDisk = (bytes: Buffer) => existsSync(path.join(process.env.DOCUMENTS_DIR!, `${sha(bytes)}.pdf`));
  const replace = (id: string, bytes: Buffer) => t.http().put(`/documents/${id}?replace=true`).set('content-type', 'application/pdf').send(bytes);

  it('deletes the replaced file when nothing else points at it, keeps it when another id shares it', async () => {
    const solo = Buffer.concat([pdf, Buffer.from('\n% solo')]);
    const shared = Buffer.concat([pdf, Buffer.from('\n% shared')]);
    const next = Buffer.concat([pdf, Buffer.from('\n% next')]);
    await put('gc-1', solo);
    await replace('gc-1', next);
    expect(onDisk(solo)).toBe(false);
    expect(onDisk(next)).toBe(true);

    await put('gc-2', shared);
    await put('gc-3', shared);
    await replace('gc-2', next);
    expect(onDisk(shared)).toBe(true); // gc-3 still reads it
    await replace('gc-3', next);
    expect(onDisk(shared)).toBe(false);
  });

  it('?replace=true with the same bytes also drops the result, so a re-run starts clean', async () => {
    expect((await put('rep-4', pdf)).status).toBe(200);
    await extract('rep-4');
    expect((await t.http().put('/documents/rep-4?replace=true').set('content-type', 'application/pdf').send(pdf)).status).toBe(200);
    expect(await hasExtraction('rep-4')).toBe(false);
  });

  it('replaces on request and drops the stale result', async () => {
    expect((await put('rep-3', pdf)).status).toBe(200);
    await extract('rep-3');
    const res = await t.http().put('/documents/rep-3?replace=true').set('content-type', 'application/pdf').send(other);
    expect(res.status).toBe(200);
    expect(res.body.sha256).toBe(createHash('sha256').update(other).digest('hex'));
    expect(await hasExtraction('rep-3')).toBe(false);
  });
});
