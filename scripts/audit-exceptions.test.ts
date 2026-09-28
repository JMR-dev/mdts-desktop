import { afterEach, expect, it } from 'vitest';

afterEach(() => {
  process.exitCode = undefined;
});

it('passes on this repository', async () => {
  await import('./audit-exceptions.ts');

  expect(process.exitCode).toBe(0);
});
