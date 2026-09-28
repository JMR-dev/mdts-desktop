import { globSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

const kinds = ['lint-suppression', 'coverage-ignore', 'dts-shim', 'unit-coverage'] as const;
type Kind = (typeof kinds)[number];

const entrySchema = z.strictObject({
  id: z.string().regex(/^[A-Z0-9-]+$/u, 'id must be upper-case letters, digits and dashes'),
  kind: z.enum(kinds),
  paths: z.array(z.string().min(1)).min(1),
  reason: z.string().min(1),
  approvedBy: z.string().min(1),
});

const registrySchema = z
  .object({ exceptions: z.array(entrySchema) })
  .superRefine((registry, context) => {
    const seen = new Set<string>();
    for (const entry of registry.exceptions) {
      if (seen.has(entry.id)) {
        context.addIssue({ code: 'custom', message: `duplicate id ${entry.id}` });
      }
      seen.add(entry.id);
    }
  });

export type Registry = z.infer<typeof registrySchema>;
type Entry = Registry['exceptions'][number];

export interface SourceFile {
  readonly path: string;
  readonly content: string;
}

export const parseRegistry = (value: unknown): Registry => registrySchema.parse(value);

export const unitCoverageExemptPaths = (registry: Registry): string[] =>
  registry.exceptions
    .filter((entry) => entry.kind === 'unit-coverage')
    .flatMap((entry) => entry.paths);

// Directive text inside string literals (test fixtures, messages) isn't a
// directive, so literals are blanked out before matching.
const stringLiteral = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/gu;
const lintDirective = /(?:\/\/|\/\*)\s*(?:oxlint|eslint)-disable/u;
const coverageDirective = /(?:\/\/|\/\*)\s*(?:v8|c8|istanbul) ignore/u;
const approvalMarker = /APPROVED\(([^)]*)\)/u;

const matches = (entry: Entry, file: string): boolean =>
  entry.paths.some((pattern) => path.posix.matchesGlob(file, pattern));

const directiveKind = (line: string): Kind | undefined => {
  const code = line.replaceAll(stringLiteral, "''");
  if (lintDirective.test(code)) {
    return 'lint-suppression';
  }
  if (coverageDirective.test(code)) {
    return 'coverage-ignore';
  }
  return undefined;
};

const checkLine = (
  file: string,
  lineNumber: number,
  line: string,
  byId: ReadonlyMap<string, Entry>,
): string | undefined => {
  const kind = directiveKind(line);
  if (kind === undefined) {
    return undefined;
  }
  const where = `${file}:${String(lineNumber)}`;
  const id = approvalMarker.exec(line)?.[1];
  if (id === undefined) {
    return `${where}: suppression has no APPROVED(<id>) marker`;
  }
  const entry = byId.get(id);
  if (entry === undefined) {
    return `${where}: APPROVED(${id}) is not in exceptions.json`;
  }
  if (entry.kind !== kind) {
    return `${where}: APPROVED(${id}) is a ${entry.kind} exception, not ${kind}`;
  }
  if (!matches(entry, file)) {
    return `${where}: APPROVED(${id}) does not cover this file`;
  }
  return undefined;
};

export const audit = (files: readonly SourceFile[], registry: Registry): string[] => {
  const byId = new Map(registry.exceptions.map((entry) => [entry.id, entry]));
  const shims = registry.exceptions.filter((entry) => entry.kind === 'dts-shim');
  const problems: string[] = [];

  for (const file of files) {
    for (const [index, line] of file.content.split('\n').entries()) {
      const problem = checkLine(file.path, index + 1, line, byId);
      if (problem !== undefined) {
        problems.push(problem);
      }
    }
    if (file.path.endsWith('.d.ts') && !shims.some((entry) => matches(entry, file.path))) {
      problems.push(`${file.path}: declaration file is not approved in exceptions.json`);
    }
  }

  for (const entry of registry.exceptions) {
    if (!files.some((file) => matches(entry, file.path))) {
      problems.push(`exceptions.json: ${entry.id} matches no files`);
    }
  }

  return problems;
};

const sourceGlobs = ['**/*.{ts,mts,cts,js,mjs,cjs}'];
const ignoredGlobs = [
  '**/node_modules/**',
  'dist/**',
  'release/**',
  'coverage/**',
  'e2e/docs-fixture/**',
];

export const runAudit = async (root: string, log: (line: string) => void): Promise<number> => {
  const registry = parseRegistry(
    JSON.parse(await readFile(path.join(root, 'exceptions.json'), 'utf8')),
  );
  const relativePaths = globSync(sourceGlobs, { cwd: root, exclude: ignoredGlobs });
  const files = await Promise.all(
    relativePaths.map(async (relativePath) => ({
      path: relativePath.split(path.sep).join('/'),
      content: await readFile(path.join(root, relativePath), 'utf8'),
    })),
  );

  const problems = audit(files, registry);
  for (const problem of problems) {
    log(problem);
  }
  if (problems.length > 0) {
    return 1;
  }
  const count = registry.exceptions.length;
  log(
    `audit-exceptions: ${String(count)} approved exception${count === 1 ? '' : 's'}, no problems`,
  );
  return 0;
};
