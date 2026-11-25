import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { registerProject } from '../workspace/projects.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const exec = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd })).stdout.trim();

/**
 * `CEZ_BASE_BRANCH` / `CEZ_BASE_REF` — where a task forked from, handed to check steps AND
 * agents. Without them a project's verify script had to hard-code its base: a task forked from
 * `staging` was diffed against `dev` and "changed" every file `staging` has over `dev` (live run
 * on spsystem: 123 files, +16581, none of them the task's).
 */
describe('task base env (CEZ_BASE_BRANCH / CEZ_BASE_REF)', () => {
  const savedEnv: Record<string, string | undefined> = {};
  let home: string;
  let repoRoot: string;
  let outFile: string;
  let store: RunStore;
  let manager: RunManager;

  beforeEach(async () => {
    for (const key of ['CEZ_DRY_RUN', 'CEZ_HOME', 'CEZ_BASE_BRANCH', 'CEZ_BASE_REF']) savedEnv[key] = process.env[key];
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-base-env-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-base-env-repo-'));
    outFile = join(home, 'check-env.txt');
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_HOME = home;
    await git(repoRoot, 'init', '-q', '-b', 'main');
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await git(repoRoot, 'add', '-A');
    await git(repoRoot, ...GIT_ID, 'commit', '-q', '-m', 'base');
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
    await registerProject(repoRoot);
  });

  afterEach(() => {
    manager.dispose();
    store.flush();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
  });

  const workflow: () => WorkflowDef = () => ({
    name: 'implement-and-verify',
    source: 'file',
    steps: [
      { id: 'implement', name: 'Implement', prompt: '{{task}}' },
      { id: 'verify', name: 'Verify', command: `printf '%s|%s' "$CEZ_BASE_BRANCH" "$CEZ_BASE_REF" > '${outFile}'` },
    ],
  });

  const settle = async (id: string): Promise<void> => {
    const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
    const deadline = Date.now() + 20_000;
    while (!terminal.has(store.getRun(id)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('run did not finish in time');
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  it('a check step in a task worktree sees the base branch and the anchored commit', async () => {
    const mainSha = await git(repoRoot, 'rev-parse', 'main');
    const record = manager.startRun(workflow(), { task: 'mock:done add a feature', worktree: true });
    await settle(record.id);

    expect(store.getRun(record.id)?.baseBranch).toBe('main');
    expect(readFileSync(outFile, 'utf8')).toBe(`main|${mainSha}`);
  });

  it('with worktree off both name the starting commit — and a parent value never leaks in', async () => {
    process.env.CEZ_BASE_BRANCH = 'stale-parent-branch';
    process.env.CEZ_BASE_REF = 'stale-parent-ref';
    const startSha = await git(repoRoot, 'rev-parse', 'HEAD');
    const record = manager.startRun(workflow(), { task: 'mock:done add a feature', worktree: false });
    await settle(record.id);

    expect(readFileSync(outFile, 'utf8')).toBe(`${startSha}|${startSha}`);
  });

  it('a run with no recorded base gets empty values, not the parent process\'s', async () => {
    process.env.CEZ_BASE_BRANCH = 'stale-parent-branch';
    process.env.CEZ_BASE_REF = 'stale-parent-ref';
    const run = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [{ id: 's', name: 's', kind: 'agent' }] });
    type Seam = { agentEnvForStep(runId: string, backend: 'claude'): Promise<{ env: Record<string, string> }> };
    const { env } = await (manager as unknown as Seam).agentEnvForStep(run.id, 'claude');
    expect(env.CEZ_BASE_BRANCH).toBe('');
    expect(env.CEZ_BASE_REF).toBe('');
  });

  it('an agent gets the same pair, anchored at the fork point of a non-default base', async () => {
    // A task forked from `staging`, which is two commits ahead of `main` — the spsystem shape.
    await git(repoRoot, 'checkout', '-q', '-b', 'staging');
    for (const n of [1, 2]) {
      writeFileSync(join(repoRoot, `staging-${n}.txt`), `${n}\n`);
      await git(repoRoot, 'add', '-A');
      await git(repoRoot, ...GIT_ID, 'commit', '-q', '-m', `staging ${n}`);
    }
    const stagingSha = await git(repoRoot, 'rev-parse', 'staging');
    await git(repoRoot, 'checkout', '-q', 'main');
    const worktreePath = join(home, 'wt');
    await git(repoRoot, 'worktree', 'add', '-q', '-b', 'cez/task', worktreePath, 'staging');
    writeFileSync(join(worktreePath, 'task.txt'), 'the task\n');
    await git(worktreePath, 'add', '-A');
    await git(worktreePath, ...GIT_ID, 'commit', '-q', '-m', 'task work');

    const run = store.createRun({ title: 't', workflow: 'w', task: 't', steps: [{ id: 's', name: 's', kind: 'agent' }] });
    store.updateRun(run.id, {
      worktreePath,
      branch: 'cez/task',
      baseBranch: 'staging',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    });

    type Seam = { agentEnvForStep(runId: string, backend: 'claude'): Promise<{ env: Record<string, string> }> };
    const { env } = await (manager as unknown as Seam).agentEnvForStep(run.id, 'claude');
    expect(env.CEZ_BASE_BRANCH).toBe('staging');
    // The fork point on staging — NOT main, and not the task's own HEAD.
    expect(env.CEZ_BASE_REF).toBe(stagingSha);
  });
});
