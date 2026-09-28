import { readFileSync } from 'node:fs';

import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

import { parseRegistry, unitCoverageExemptPaths } from './scripts/lib/exceptions.ts';

const registry = parseRegistry(JSON.parse(readFileSync('exceptions.json', 'utf8')));

export default defineConfig({
  test: {
    testTimeout: 10_000,
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
          exclude: ['src/renderer/**'],
        },
      },
      {
        test: {
          name: 'renderer',
          include: ['src/renderer/**/*.test.ts'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'scripts/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.d.ts', ...unitCoverageExemptPaths(registry)],
      reporter: ['text', 'html', 'lcov'],
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    },
  },
});
