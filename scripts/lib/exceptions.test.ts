import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { audit, parseRegistry, runAudit, unitCoverageExemptPaths } from './exceptions.ts';

const approved = (id: string, kind: string, paths: string[]): Record<string, unknown> => ({
  id,
  kind,
  paths,
  reason: 'test reason',
  approvedBy: 'test approver',
});

describe('parseRegistry', () => {
  it('accepts a well-formed registry', () => {
    const registry = parseRegistry({
      exceptions: [approved('LINT-1', 'lint-suppression', ['src/a.ts'])],
    });

    expect(registry.exceptions).toHaveLength(1);
  });

  it('rejects entries with an unknown kind', () => {
    expect(() =>
      parseRegistry({ exceptions: [approved('X-1', 'anything-goes', ['src/a.ts'])] }),
    ).toThrow(/kind/u);
  });

  it('rejects duplicate ids', () => {
    expect(() =>
      parseRegistry({
        exceptions: [
          approved('LINT-1', 'lint-suppression', ['src/a.ts']),
          approved('LINT-1', 'lint-suppression', ['src/b.ts']),
        ],
      }),
    ).toThrow(/duplicate id LINT-1/u);
  });

  it('rejects ids that the APPROVED(...) marker cannot express', () => {
    expect(() =>
      parseRegistry({ exceptions: [approved('lint one', 'lint-suppression', ['src/a.ts'])] }),
    ).toThrow(/id/u);
  });
});

describe('audit', () => {
  const registry = parseRegistry({
    exceptions: [
      approved('LINT-1', 'lint-suppression', ['src/a.ts']),
      approved('COV-1', 'coverage-ignore', ['src/**/*.ts']),
      approved('DTS-1', 'dts-shim', ['src/types/mdts.d.ts']),
      approved('UNIT-1', 'unit-coverage', ['src/main/electron/**']),
    ],
  });
  const baseline = [
    { path: 'src/a.ts', content: 'export const a = 1;\n' },
    { path: 'src/types/mdts.d.ts', content: 'export {};\n' },
    { path: 'src/main/electron/menu.ts', content: 'export {};\n' },
  ];

  it('passes a tree with no suppressions and no stale entries', () => {
    const files = [
      ...baseline,
      { path: 'src/a.ts', content: 'x(); // oxlint-disable-line no-x -- APPROVED(LINT-1)\n' },
      { path: 'src/b.ts', content: '/* v8 ignore next -- APPROVED(COV-1) */\n' },
    ];

    expect(audit(files, registry)).toStrictEqual([]);
  });

  it('flags an oxlint suppression without an approval marker', () => {
    const files = [
      ...baseline,
      { path: 'src/a.ts', content: 'const a = 1;\n// oxlint-disable-next-line no-x\n' },
    ];

    expect(audit(files, registry)).toStrictEqual([
      'src/a.ts:2: suppression has no APPROVED(<id>) marker',
    ]);
  });

  it('treats eslint directives, c8 and istanbul comments the same way', () => {
    const files = [
      ...baseline,
      {
        path: 'src/c.ts',
        content: '/* eslint-disable no-x */\n/* c8 ignore next */\n// istanbul ignore else\n',
      },
    ];

    expect(audit(files, registry)).toStrictEqual([
      'src/c.ts:1: suppression has no APPROVED(<id>) marker',
      'src/c.ts:2: suppression has no APPROVED(<id>) marker',
      'src/c.ts:3: suppression has no APPROVED(<id>) marker',
    ]);
  });

  it('ignores directive text inside string literals', () => {
    const content = [
      "const a = '// oxlint-disable';",
      "const b = 'x(); /* v8 ignore next */';",
      'const c = "it\\"s // eslint-disable";',
      'const d = `// c8 ignore next`;',
      "// a comment that doesn't disable anything",
      '',
    ].join('\n');
    const files = [...baseline, { path: 'src/d.ts', content }];

    expect(audit(files, registry)).toStrictEqual([]);
  });

  it('flags an approval id that is not in the registry', () => {
    const files = [
      ...baseline,
      { path: 'src/a.ts', content: '// oxlint-disable -- APPROVED(NOPE)\n' },
    ];

    expect(audit(files, registry)).toStrictEqual([
      'src/a.ts:1: APPROVED(NOPE) is not in exceptions.json',
    ]);
  });

  it('flags an approval whose entry does not cover the file', () => {
    const files = [
      ...baseline,
      { path: 'src/other.ts', content: '// oxlint-disable-line -- APPROVED(LINT-1)\n' },
    ];

    expect(audit(files, registry)).toStrictEqual([
      'src/other.ts:1: APPROVED(LINT-1) does not cover this file',
    ]);
  });

  it('flags an approval of the wrong kind', () => {
    const files = [
      ...baseline,
      { path: 'src/a.ts', content: '// oxlint-disable-line -- APPROVED(COV-1)\n' },
    ];

    expect(audit(files, registry)).toStrictEqual([
      'src/a.ts:1: APPROVED(COV-1) is a coverage-ignore exception, not lint-suppression',
    ]);
  });

  it('flags a declaration file with no dts-shim entry', () => {
    const files = [...baseline, { path: 'src/types/other.d.ts', content: 'export {};\n' }];

    expect(audit(files, registry)).toStrictEqual([
      'src/types/other.d.ts: declaration file is not approved in exceptions.json',
    ]);
  });

  it('flags registry entries that no longer match any file', () => {
    expect(audit([], registry)).toStrictEqual([
      'exceptions.json: LINT-1 matches no files',
      'exceptions.json: COV-1 matches no files',
      'exceptions.json: DTS-1 matches no files',
      'exceptions.json: UNIT-1 matches no files',
    ]);
  });
});

describe('unitCoverageExemptPaths', () => {
  it('lists the paths of unit-coverage entries only', () => {
    const registry = parseRegistry({
      exceptions: [
        approved('UNIT-1', 'unit-coverage', ['src/main/electron/**', 'src/main/index.ts']),
        approved('LINT-1', 'lint-suppression', ['src/a.ts']),
      ],
    });

    expect(unitCoverageExemptPaths(registry)).toStrictEqual([
      'src/main/electron/**',
      'src/main/index.ts',
    ]);
  });
});

describe('runAudit', () => {
  let root = '';
  const lines: string[] = [];
  const log = (line: string): void => {
    lines.push(line);
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'audit-'));
    lines.length = 0;
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(
      path.join(root, 'exceptions.json'),
      JSON.stringify({ exceptions: [approved('LINT-1', 'lint-suppression', ['src/a.ts'])] }),
    );
    await writeFile(path.join(root, 'node_modules', 'pkg', 'index.d.ts'), 'export {};\n');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns 0 and reports success for a clean tree', async () => {
    await writeFile(path.join(root, 'src', 'a.ts'), '// oxlint-disable-line -- APPROVED(LINT-1)\n');

    await expect(runAudit(root, log)).resolves.toBe(0);
    expect(lines).toStrictEqual(['audit-exceptions: 1 approved exception, no problems']);
  });

  it('returns 1 and prints every problem', async () => {
    await writeFile(path.join(root, 'src', 'a.ts'), '// oxlint-disable-line no-x\n');

    await expect(runAudit(root, log)).resolves.toBe(1);
    expect(lines).toStrictEqual(['src/a.ts:1: suppression has no APPROVED(<id>) marker']);
  });
});
