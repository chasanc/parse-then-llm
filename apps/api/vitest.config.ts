import { defineConfig } from 'vitest/config';

// Integration specs create and drop a scratch database, which takes a moment.
export default defineConfig({ test: { hookTimeout: 30_000, testTimeout: 15_000 } });
