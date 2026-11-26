import { describe, expect, it } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from '../src/runner/circuit-breaker';
import { backoffMs } from '../src/runner/runner.service';

const boom = () => Promise.reject(new Error('down'));

function breaker(threshold = 3, cooldownMs = 1000) {
  const b = new CircuitBreaker(threshold, cooldownMs);
  let t = 1_000_000;
  b.now = () => t;
  return { b, advance: (ms: number) => (t += ms) };
}

describe('CircuitBreaker', () => {
  it('stays closed below the threshold and a success resets the count', async () => {
    const { b } = breaker();
    for (let i = 0; i < 2; i++) await expect(b.run(boom)).rejects.toThrow('down');
    await b.run(async () => 1);
    for (let i = 0; i < 2; i++) await expect(b.run(boom)).rejects.toThrow('down');
    expect(b.isOpen).toBe(false);
  });

  it('does not count errors the caller says are not upstream failures', async () => {
    const { b } = breaker();
    for (let i = 0; i < 10; i++) await expect(b.run(boom, () => false)).rejects.toThrow('down');
    expect(b.isOpen).toBe(false);
  });

  it('opens after the threshold and rejects without calling the upstream', async () => {
    const { b } = breaker();
    for (let i = 0; i < 3; i++) await expect(b.run(boom)).rejects.toThrow('down');
    let called = false;
    const err = await b.run(async () => (called = true)).catch((e) => e);
    expect(err).toBeInstanceOf(CircuitOpenError);
    expect(err.retryAfterMs).toBe(1000);
    expect(called).toBe(false);
  });

  it('lets one trial through after the cooldown; success closes it', async () => {
    const { b, advance } = breaker();
    for (let i = 0; i < 3; i++) await b.run(boom).catch(() => {});
    advance(1000);
    await expect(b.run(async () => 'ok')).resolves.toBe('ok');
    expect(b.isOpen).toBe(false);
    await expect(b.run(async () => 'again')).resolves.toBe('again');
  });

  it('re-opens for a full cooldown when the trial fails', async () => {
    const { b, advance } = breaker();
    for (let i = 0; i < 3; i++) await b.run(boom).catch(() => {});
    advance(1000);
    await expect(b.run(boom)).rejects.toThrow('down');
    await expect(b.run(async () => 1)).rejects.toBeInstanceOf(CircuitOpenError);
    advance(1000);
    await expect(b.run(async () => 1)).resolves.toBe(1);
  });

  it('allows only one trial at a time', async () => {
    const { b, advance } = breaker();
    for (let i = 0; i < 3; i++) await b.run(boom).catch(() => {});
    advance(1000);
    let release!: () => void;
    const trial = b.run(() => new Promise<void>((r) => (release = r)));
    await expect(b.run(async () => 1)).rejects.toBeInstanceOf(CircuitOpenError);
    release();
    await trial;
  });
});

describe('backoffMs', () => {
  it('doubles per attempt and stops at the cap', () => {
    expect([1, 2, 3, 4, 10].map((n) => backoffMs(n, 1000, 5000))).toEqual([1000, 2000, 4000, 5000, 5000]);
  });
});
