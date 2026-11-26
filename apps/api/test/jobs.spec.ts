import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, TestApp } from './helpers/test-app';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(async () => {
  await t.stop();
});

const post = (body: unknown) => t.http().post('/jobs').send(body as object);
const count = async (hash: string) =>
  Number((await t.pool.query('SELECT count(*) FROM jobs WHERE document_hash = $1', [hash])).rows[0].count);

describe('POST /jobs', () => {
  it('creates a job, then returns the same active job for a repeat', async () => {
    const first = await post({ documentId: 'doc-1', documentHash: HASH_A });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ documentId: 'doc-1', status: 'pending' });

    const again = await post({ documentId: 'doc-1', documentHash: HASH_A });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
  });

  it('never creates duplicate work under concurrent requests', async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, () => post({ documentId: 'doc-2', documentHash: HASH_B })),
    );
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await count(HASH_B)).toBe(1);
  });

  it('allows a new job once the previous one is no longer active', async () => {
    const first = await post({ documentId: 'doc-3', documentHash: 'c'.repeat(64) });
    await t.pool.query(`UPDATE jobs SET status = 'done' WHERE id = $1`, [first.body.id]);
    const second = await post({ documentId: 'doc-3', documentHash: 'c'.repeat(64) });
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);
  });

  it('lets two documents with identical bytes run at the same time', async () => {
    const hash = '9'.repeat(64);
    const a = await post({ documentId: 'twin-a', documentHash: hash });
    const b = await post({ documentId: 'twin-b', documentHash: hash });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.body.id).not.toBe(a.body.id);
  });

  it('uses idempotencyKey in place of the hash, and rejects reuse for another document', async () => {
    const a = await post({ documentId: 'doc-4', documentHash: 'd'.repeat(64), idempotencyKey: 'k1' });
    const b = await post({ documentId: 'doc-4', documentHash: 'e'.repeat(64), idempotencyKey: 'k1' });
    expect(b.body.id).toBe(a.body.id);
    const c = await post({ documentId: 'doc-other', documentHash: 'f'.repeat(64), idempotencyKey: 'k1' });
    expect(c.status).toBe(409);
  });

  it.each([
    [{}],
    [{ documentId: 'x' }],
    [{ documentId: 'x', documentHash: 'not-a-hash' }],
    [{ documentId: '', documentHash: HASH_A }],
    [{ documentId: 'x', documentHash: HASH_A, idempotencyKey: '' }],
  ])('rejects invalid body %j', async (body) => {
    expect((await post(body)).status).toBe(400);
  });
});

describe('jobs_active_dedupe index', () => {
  it('rejects a second active row for the same key at the database level', async () => {
    const insert = () =>
      t.pool.query(`INSERT INTO jobs (document_id, document_hash, dedupe_key) VALUES ('d', 'h', 'raw-key')`);
    await insert();
    await expect(insert()).rejects.toMatchObject({ code: '23505' });
  });
});
