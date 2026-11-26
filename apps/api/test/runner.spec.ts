import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CircuitOpenError } from '../src/runner/circuit-breaker';
import { ExtractorError, Extractors } from '../src/runner/extractors';
import { RunnerService } from '../src/runner/runner.service';
import { startTestApp, TestApp } from './helpers/test-app';

process.env.CONCURRENCY = '2';
process.env.MAX_ATTEMPTS = '3';
process.env.BACKOFF_BASE_MS = '60000';
process.env.BREAKER_THRESHOLD = '50'; // out of the way, except in the breaker test

const FIXTURES = path.resolve(__dirname, '../../../eval/fixtures/expected');
const expected = (name: string) => JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));

/** What Tier 1 posts for a page it cannot read. */
const unreadable = (documentId: string) => ({
  documentId, extractionTier: 1, coverageScore: 0, fieldSources: {}, status: 'needs_review',
  vendor: null, invoiceNumber: null, issueDate: null, currency: null, lineItems: [], total: null,
});

let t: TestApp;
let runner: RunnerService;
const calls: Array<[number, string]> = [];
// Each test sets how the fake workers behave. A worker "posts its result" by calling the real callback.
let behave: (tier: 1 | 2, documentId: string) => Promise<void>;
const fake = { run: (tier: 1 | 2, id: string) => { calls.push([tier, id]); return behave(tier, id); } } as unknown as Extractors;

const post = async (tier: 1 | 2, payload: object): Promise<void> => {
  await t.signed(`/internal/extractions/tier${tier}`, payload).expect(204);
};
const enqueue = async (documentId: string) => {
  const res = await t.http().post('/jobs').send({ documentId, documentHash: createHash('sha256').update(documentId).digest('hex') });
  expect(res.status).toBe(201);
  return res.body.id as string;
};
const job = async (id: string) => (await t.pool.query('SELECT * FROM jobs WHERE id = $1', [id])).rows[0];
const makeDue = (id: string) => t.pool.query('UPDATE jobs SET next_attempt_at = now() WHERE id = $1', [id]);

beforeAll(async () => {
  t = await startTestApp({ extractors: fake });
  runner = t.app.get(RunnerService);
});
afterAll(() => t.stop());
beforeEach(() => {
  calls.length = 0;
  behave = async () => {};
});

describe('runner', () => {
  it('finishes at tier 1 when the parser is confident', async () => {
    behave = async (tier, id) => post(1, { ...expected('clean-01'), documentId: id, extractionTier: 1 });
    const id = await enqueue('r-clean');
    await runner.tick();
    expect(calls).toEqual([[1, 'r-clean']]);
    expect((await job(id)).status).toBe('done');
  });

  it('escalates to tier 2 when tier 1 asks for review, and the merged result is ai_enhanced', async () => {
    behave = async (tier, docId) =>
      tier === 1 ? post(1, unreadable(docId)) : post(2, { ...expected('scanned-01'), documentId: docId });
    const id = await enqueue('r-scan');
    await runner.tick();
    expect((await job(id)).status).toBe('pending');
    expect((await job(id)).tier_done).toBe(1);
    await runner.tick();
    expect(calls).toEqual([[1, 'r-scan'], [2, 'r-scan']]);
    expect((await job(id)).status).toBe('done');
    const row = (await t.pool.query(`SELECT status FROM extractions WHERE document_id = 'r-scan'`)).rows[0];
    expect(row.status).toBe('ai_enhanced');
  });

  it('backs off on a transient error and does not retry before the job is due', async () => {
    behave = async () => { throw new ExtractorError('tier 1 answered 503', true); };
    const id = await enqueue('r-flaky');
    await runner.tick();
    const failed = await job(id);
    expect(failed).toMatchObject({ status: 'pending', attempts: 1, last_error: 'tier 1 answered 503' });
    expect(new Date(failed.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 30_000);

    await runner.tick();
    expect(calls).toHaveLength(1); // not due: nothing claimed

    behave = async (tier, docId) => post(1, { ...expected('clean-02'), documentId: docId, extractionTier: 1 });
    await makeDue(id);
    await runner.tick();
    expect((await job(id)).status).toBe('done');
  });

  it('gives up after the maximum attempts, keeping the last error', async () => {
    behave = async () => { throw new ExtractorError('tier 1 answered 502', true); };
    const id = await enqueue('r-dead');
    for (let i = 0; i < 3; i++) {
      await runner.tick();
      await makeDue(id);
    }
    expect(await job(id)).toMatchObject({ status: 'failed', attempts: 3, last_error: 'tier 1 answered 502' });
    expect(calls).toHaveLength(3);
  });

  it('fails a terminal error on the first attempt', async () => {
    behave = async () => { throw new ExtractorError('tier 1 answered 404', false); };
    const id = await enqueue('r-missing');
    await runner.tick();
    expect(await job(id)).toMatchObject({ status: 'failed', attempts: 1 });
  });

  it('stops calling tier 2 once the daily cap is reached, and leaves the tier 1 result for a person', async () => {
    runner.cfg.maxTier2PerDay = (await runner.tier2RunsLastDay()) + 1; // earlier tests already stored some tier 2 results
    try {
      behave = async (tier, docId) => (tier === 1 ? post(1, unreadable(docId)) : post(2, { ...expected('scanned-01'), documentId: docId }));
      const first = await enqueue('cap-1');
      await runner.tick();
      await runner.tick(); // tier 2 runs: 0 results so far, cap is 1
      expect((await job(first)).status).toBe('done');

      const second = await enqueue('cap-2');
      behave = async (_tier, docId) => post(1, { ...expected('clean-01'), documentId: docId, extractionTier: 1, status: 'needs_review', total: null, fieldSources: {} });
      await runner.tick();
      calls.length = 0;
      await runner.tick(); // tier 2 refused: 1 result in the last day
      expect(calls).toEqual([]);
      expect(await job(second)).toMatchObject({ status: 'failed', last_error: 'daily tier 2 cap reached' });
      expect((await t.pool.query(`SELECT status FROM extractions WHERE document_id = 'cap-2'`)).rows[0].status).toBe('needs_review');
    } finally {
      runner.cfg.maxTier2PerDay = 0;
    }
  });

  it('fails a job whose tier 2 answers without posting a result, after the retries', async () => {
    behave = async (tier, docId) => (tier === 1 ? post(1, unreadable(docId)) : undefined);
    const id = await enqueue('r-silent');
    for (let i = 0; i < 4; i++) {
      await runner.tick();
      await makeDue(id);
    }
    expect(await job(id)).toMatchObject({ status: 'failed', last_error: 'tier 2 returned without posting a result' });
  });

  it('decides escalation from the derived status, not the status the extractor claims', async () => {
    // Tier 1 claims 'verified' but leaves the total out, so the merged result is incomplete.
    behave = async (tier, docId) => post(1, { ...expected('clean-01'), documentId: docId, extractionTier: 1, total: null, status: 'verified' });
    const id = await enqueue('r-liar');
    await runner.tick();
    expect(await job(id)).toMatchObject({ status: 'pending', tier_done: 1 });
    await t.pool.query(`UPDATE jobs SET status = 'failed' WHERE id = $1`, [id]); // keep it out of later ticks
  });

  it('fails a job that keeps getting re-claimed after its attempts ran out', async () => {
    const id = await enqueue('r-poison');
    await t.pool.query(`UPDATE jobs SET status = 'running', attempts = 3, lease_until = now() - interval '1 second' WHERE id = $1`, [id]);
    await runner.tick();
    expect(calls).toHaveLength(0);
    expect(await job(id)).toMatchObject({ status: 'failed', last_error: 'attempts exhausted' });
  });

  it('picks up a job whose worker died, once the lease has expired', async () => {
    const id = await enqueue('r-crash');
    await t.pool.query(`UPDATE jobs SET status = 'running', lease_until = now() + interval '1 hour' WHERE id = $1`, [id]);
    await runner.tick();
    expect(calls).toHaveLength(0); // still leased

    behave = async (tier, docId) => post(1, { ...expected('clean-03'), documentId: docId, extractionTier: 1 });
    await t.pool.query(`UPDATE jobs SET lease_until = now() - interval '1 second' WHERE id = $1`, [id]);
    await runner.tick();
    expect((await job(id)).status).toBe('done');
  });

  it('never runs more jobs at once than CONCURRENCY, and never claims the same job twice', async () => {
    let live = 0;
    let peak = 0;
    const seen: string[] = [];
    behave = async (tier, docId) => {
      seen.push(docId);
      peak = Math.max(peak, ++live);
      await new Promise((r) => setTimeout(r, 40));
      live--;
      await post(1, { ...expected('clean-01'), documentId: docId, extractionTier: 1 });
    };
    const ids = await Promise.all(Array.from({ length: 6 }, (_, i) => enqueue(`r-par-${i}`)));
    await Promise.all([runner.tick(), runner.tick(), runner.tick()]); // overlapping ticks must not over-claim
    while ((await Promise.all(ids.map(job))).some((j) => j.status !== 'done')) await runner.tick();
    expect(peak).toBe(2);
    expect(new Set(seen).size).toBe(6);
    expect(seen).toHaveLength(6);
  });

  it('parks jobs without spending attempts while the circuit is open', async () => {
    const breaker = runner.breakers[1];
    const open = () => Promise.reject(new Error('down'));
    for (let i = 0; i < 50; i++) await breaker.run(open).catch(() => {});
    expect(breaker.isOpen).toBe(true);

    const id = await enqueue('r-circuit');
    await runner.tick();
    expect(calls).toHaveLength(0);
    const parked = await job(id);
    expect(parked).toMatchObject({ status: 'pending', attempts: 0, last_error: 'circuit open' });
    expect(new Date(parked.next_attempt_at).getTime()).toBeGreaterThan(Date.now());

    // upstream recovers: after the cooldown the trial call succeeds and the job completes
    const realNow = breaker.now;
    breaker.now = () => realNow() + 60_000;
    behave = async (tier, docId) => post(1, { ...expected('clean-01'), documentId: docId, extractionTier: 1 });
    await makeDue(id);
    await runner.tick();
    expect((await job(id)).status).toBe('done');
    expect(breaker.isOpen).toBe(false);
  });
});

it('a CircuitOpenError carries how long to wait', () => {
  expect(new CircuitOpenError(500).retryAfterMs).toBe(500);
});
