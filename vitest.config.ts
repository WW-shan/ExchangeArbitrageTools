import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/tests/**/*.test.ts', 'apps/**/tests/**/*.test.ts'],
    environment: 'node',
    // This repository is tested on Windows with a small container budget; the
    // default parallel worker pool can fail before any test runs.
    fileParallelism: false,
    maxWorkers: 1,
    pool: 'threads',
  },
});
