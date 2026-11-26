import { afterEach, describe, expect, it } from 'vitest';
import { ApiKeyGuard } from '../src/common/api-key.guard';

const saved = process.env.PTL_API_KEY;
afterEach(() => {
  if (saved === undefined) delete process.env.PTL_API_KEY;
  else process.env.PTL_API_KEY = saved;
});

describe('ApiKeyGuard configuration', () => {
  it.each([undefined, '', '1234567890', 'short'])('refuses to start with %j', (key) => {
    if (key === undefined) delete process.env.PTL_API_KEY;
    else process.env.PTL_API_KEY = key;
    expect(() => new ApiKeyGuard()).toThrow(/PTL_API_KEY/);
  });

  it('accepts a generated key', () => {
    process.env.PTL_API_KEY = 'a'.repeat(64);
    expect(() => new ApiKeyGuard()).not.toThrow();
  });
});
