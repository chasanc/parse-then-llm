import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, TestApp } from './helpers/test-app';

const clean = JSON.parse(readFileSync(path.resolve(__dirname, '../../../eval/fixtures/expected/clean-01.json'), 'utf8'));
let t: TestApp;
beforeAll(async () => (t = await startTestApp()));
afterAll(() => t.stop());

describe('read endpoints', () => {
  it('GET /jobs/:id returns status and retry state, 404 for unknown or malformed ids', async () => {
    const created = await t.http().post('/jobs').send({ documentId: 'read-1', documentHash: 'a'.repeat(64) });
    const res = await t.http().get(`/jobs/${created.body.id}`).expect(200);
    expect(res.body).toMatchObject({ id: created.body.id, documentId: 'read-1', status: 'pending', attempts: 0, tierDone: 0, lastError: null });
    await t.http().get('/jobs/00000000-0000-0000-0000-000000000000').expect(404);
    await t.http().get('/jobs/not-a-uuid').expect(404);
  });

  it('GET /extractions/:documentId returns the merged result in contract shape, 404 before any callback', async () => {
    await t.http().get('/extractions/read-2').expect(404);
    await t.signed('/internal/extractions/tier1', { ...clean, documentId: 'read-2' }).expect(204);
    const res = await t.http().get('/extractions/read-2').expect(200);
    expect(res.body).toEqual({ ...clean, documentId: 'read-2' });
  });

  it('GET /extractions?status=needs_review lists the queue oldest first, pages with after, rejects unknown statuses', async () => {
    const review = (id: string) => ({ ...clean, documentId: id, extractionTier: 1, status: 'needs_review', total: null, fieldSources: { ...clean.fieldSources, total: undefined } });
    for (const id of ['q-1', 'q-2', 'q-3']) await t.signed('/internal/extractions/tier1', review(id)).expect(204);
    const page1 = await t.http().get('/extractions?status=needs_review&limit=2').expect(200);
    const ids = page1.body.map((r: { documentId: string }) => r.documentId);
    expect(ids).toEqual(['q-1', 'q-2']);
    expect(page1.body[0]).toMatchObject({ status: 'needs_review', extractionTier: 1 });
    const page2 = await t.http().get(`/extractions?status=needs_review&limit=2&after=q-2`).expect(200);
    expect(page2.body.map((r: { documentId: string }) => r.documentId)).toEqual(['q-3']);
    await t.http().get('/extractions?status=bogus').expect(400);
    await t.anonymous().get('/extractions').expect(401);
  });

  it('GET /metrics needs the key and exposes queue, token and runner series', async () => {
    await t.anonymous().get('/metrics').expect(401);
    const run = { ...clean, documentId: 'm-1', extractionTier: 2, usage: { inputTokens: 1000, outputTokens: 50 } };
    await t.signed('/internal/extractions/tier2', run).expect(204);
    const res = await t.http().get('/metrics').expect(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toMatch(/^jobs\{status="pending"\} \d+$/m);
    expect(res.text).toMatch(/^llm_tokens_total\{direction="input"\} 1000$/m);
    expect(res.text).toMatch(/^llm_tokens_total\{direction="output"\} 50$/m);
    expect(res.text).toMatch(/^extractions_needs_review \d+$/m);
    expect(res.text).toMatch(/^circuit_open\{tier="2"\} 0$/m);
  });
});
