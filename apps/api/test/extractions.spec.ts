import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, TestApp } from './helpers/test-app';

const expectedDir = path.resolve(__dirname, '../../../eval/fixtures/expected');
const load = (name: string) => JSON.parse(readFileSync(path.join(expectedDir, `${name}.json`), 'utf8'));
const fixtureNames = readdirSync(expectedDir).map((f) => f.replace('.json', ''));

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
});
afterAll(async () => {
  await t.stop();
});

const route = (tier: number) => `/internal/extractions/tier${tier}`;
const stored = async (documentId: string) =>
  (await t.pool.query('SELECT * FROM extractions WHERE document_id = $1', [documentId])).rows[0];
const jobStatus = async (documentId: string) =>
  (await t.pool.query('SELECT status FROM jobs WHERE document_id = $1', [documentId])).rows[0]?.status;
const enqueue = (documentId: string) =>
  t.http().post('/jobs').send({ documentId, documentHash: createHash('sha256').update(documentId).digest('hex') });

describe('HMAC guard', () => {
  const body = load('clean-01');

  it('rejects a missing signature', async () => {
    const res = await t.http().post(route(1)).send(body);
    expect(res.status).toBe(401);
  });

  it('rejects a wrong signature of the right length', async () => {
    expect((await t.signed(route(1), body, '0'.repeat(64))).status).toBe(401);
  });

  it('rejects a malformed signature', async () => {
    expect((await t.signed(route(1), body, 'zz')).status).toBe(401);
  });

  it('rejects a valid signature of a different body', async () => {
    const signatureOfOther = t.sign(JSON.stringify({ ...body, documentId: 'tampered' }));
    expect((await t.signed(route(1), body, signatureOfOther)).status).toBe(401);
  });

  it('writes nothing when rejected', async () => {
    expect(await stored('clean-01')).toBeUndefined();
  });
});

describe('payload validation', () => {
  it('rejects a body that breaks the contract', async () => {
    const res = await t.signed(route(1), { ...load('clean-01'), total: 'ten' });
    expect(res.status).toBe(400);
  });

  it('rejects a tier that does not match the route', async () => {
    expect((await t.signed(route(2), load('clean-01'))).status).toBe(400);
  });
});

describe('fixtures end to end', () => {
  it.each(fixtureNames)('%s lands as its expected result', async (name) => {
    const expected = load(name);
    const { extractionTier: tier } = expected;
    await enqueue(name);
    expect((await t.signed(route(tier), expected)).status).toBe(204);

    const row = await stored(name);
    expect(row.status).toBe(expected.status);
    expect(row.extraction_tier).toBe(tier);
    expect(Number(row.coverage_score)).toBe(expected.coverageScore);
    for (const f of ['vendor', 'invoiceNumber', 'issueDate', 'currency', 'lineItems', 'total']) {
      expect(row.fields[f]).toEqual(expected[f]);
    }
    expect(await jobStatus(name)).toBe('done');
  });
});

describe('escalation and merge', () => {
  const tier1 = { ...load('mismatch-01'), documentId: 'esc-1', extractionTier: 1, status: 'needs_review' };

  it('keeps the job active after a needs_review tier-1 result, and finishes it on tier 2', async () => {
    await enqueue('esc-1');
    await t.signed(route(1), tier1);
    expect(await jobStatus('esc-1')).toBe('pending');
    expect((await stored('esc-1')).status).toBe('needs_review');

    await t.signed(route(2), { ...load('mismatch-01'), documentId: 'esc-1' });
    expect(await jobStatus('esc-1')).toBe('done');
  });

  it('never lets blank or zero tier-2 values clobber tier-1 values', async () => {
    const blank = {
      ...load('empty-01'),
      documentId: 'esc-1',
      extractionTier: 2,
      vendor: '',
      total: 0,
    };
    await t.signed(route(2), blank);
    const row = await stored('esc-1');
    expect(row.fields.vendor).toBe('Delta Freight Inc');
    expect(row.fields.total).toBe(55000);
    expect(row.field_sources.vendor).toBe('pdf');
  });

  it('fills only the fields tier 1 missed, recording llm provenance for them', async () => {
    const partial = {
      ...load('empty-01'),
      documentId: 'esc-2',
      extractionTier: 1,
      vendor: 'Acme',
      fieldSources: { vendor: 'pdf' },
    };
    await t.signed(route(1), partial);
    await t.signed(route(2), { ...load('clean-01'), documentId: 'esc-2', extractionTier: 2, vendor: 'Other' });
    const row = await stored('esc-2');
    expect(row.fields.vendor).toBe('Acme');
    expect(row.fields.invoiceNumber).toBe('INV-2026-0001');
    expect(row.field_sources).toMatchObject({ vendor: 'pdf', invoiceNumber: 'llm' });
    expect(row.status).toBe('ai_enhanced');
  });

  it('lets a tier-1 re-run replace tier-2 values for the same field', async () => {
    await t.signed(route(2), { ...load('clean-01'), documentId: 'esc-3', extractionTier: 2, vendor: 'From LLM' });
    await t.signed(route(1), { ...load('clean-01'), documentId: 'esc-3', vendor: 'From parser' });
    expect((await stored('esc-3')).fields.vendor).toBe('From parser');
  });

  it('is unchanged when the same callback is delivered twice, but keeps both runs', async () => {
    const body = { ...load('clean-02'), documentId: 'dup-1' };
    await t.signed(route(1), body);
    const once = await stored('dup-1');
    await t.signed(route(1), body);
    const twice = await stored('dup-1');
    expect(twice.fields).toEqual(once.fields);
    expect(twice.status).toBe(once.status);
    const runs = await t.pool.query(`SELECT count(*) FROM extraction_runs WHERE document_id = 'dup-1'`);
    expect(Number(runs.rows[0].count)).toBe(2);
  });

  it('merges concurrent tier callbacks for one document without losing either', async () => {
    const t1 = { ...load('empty-01'), documentId: 'race-1', extractionTier: 1, vendor: 'Acme', fieldSources: { vendor: 'pdf' } };
    const t2 = { ...load('empty-01'), documentId: 'race-1', extractionTier: 2, invoiceNumber: 'X-1' };
    await Promise.all([t.signed(route(1), t1), t.signed(route(2), t2)]);
    const row = await stored('race-1');
    expect(row.fields).toMatchObject({ vendor: 'Acme', invoiceNumber: 'X-1' });
  });
});

describe('result for replaced bytes', () => {
  const pdfBytes = readFileSync(path.resolve(__dirname, '../../../eval/fixtures/pdf/clean-01.pdf'));
  const put = (id: string, body: Buffer) => t.http().put(`/documents/${id}?replace=true`).set('content-type', 'application/pdf').send(body);
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const payload = (id: string) => ({ ...load('clean-01'), documentId: id, extractionTier: 1 });

  it('is dropped when the worker read bytes that are no longer current', async () => {
    const old = pdfBytes;
    const fresh = Buffer.concat([pdfBytes, Buffer.from('\n% fresh')]);
    await put('stale-1', old);
    await put('stale-1', fresh); // replaced while a worker was still on `old`
    await t.signed(route(1), payload('stale-1')).set('x-document-sha256', sha(old)).expect(204);
    expect(await stored('stale-1')).toBeUndefined();

    await t.signed(route(1), payload('stale-1')).set('x-document-sha256', sha(fresh)).expect(204);
    expect(await stored('stale-1')).toBeDefined();
  });
});

describe('extraction_runs', () => {
  it('is immutable', async () => {
    await expect(t.pool.query(`UPDATE extraction_runs SET tier = 1`)).rejects.toThrow(/immutable/);
    await expect(t.pool.query(`DELETE FROM extraction_runs`)).rejects.toThrow(/immutable/);
  });
});
