import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { worktreeTreeId } from '../git-worktree.ts';

const run = promisify(execFile);
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@local'];
let dir: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cez-tree-'));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  writeFileSync(join(dir, '.gitignore'), '.env\n');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  await run('git', ['add', '-A'], { cwd: dir });
  await run('git', [...ID, 'commit', '-q', '-m', 'base'], { cwd: dir });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('worktreeTreeId — what a preview was built from', () => {
  it('does not move when the same files get committed (cezar autosave)', async () => {
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    writeFileSync(join(dir, 'new.txt'), 'x\n');
    const before = await worktreeTreeId(dir);
    await run('git', ['add', '-A'], { cwd: dir });
    await run('git', [...ID, 'commit', '-q', '-m', 'cezar autosave (turn end)'], { cwd: dir });
    expect(await worktreeTreeId(dir)).toBe(before);
  });

  it('moves when a tracked or untracked file changes, but not for an ignored one', async () => {
    const base = await worktreeTreeId(dir);
    writeFileSync(join(dir, '.env'), 'SECRET=1\n');
    expect(await worktreeTreeId(dir)).toBe(base);
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    expect(await worktreeTreeId(dir)).not.toBe(base);
  });

  it('never touches the real index', async () => {
    writeFileSync(join(dir, 'untracked.txt'), 'u\n');
    await worktreeTreeId(dir);
    const { stdout } = await run('git', ['status', '--porcelain'], { cwd: dir });
    expect(stdout).toContain('?? untracked.txt');
  });

  it('is undefined outside a repository', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'cez-plain-'));
    try {
      expect(await worktreeTreeId(plain)).toBeUndefined();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
