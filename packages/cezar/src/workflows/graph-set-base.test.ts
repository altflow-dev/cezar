import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { worktreeShortstat } from '../git-worktree.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { graphIssues, graphToSteps, type WorkflowGraph } from './graph.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * `git.set-base` end to end (spec 2026-11-25-workflow-set-base): a real RunManager, a real repo
 * with a `main` the task forks from and a `staging` the ticket names, `CEZ_DRY_RUN=1`.
 */
describe('git.set-base', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let savedDryRun: string | undefined;
  let stagingSha: string;

  const git = async (...args: string[]) => (await run('git', args, { cwd: repoRoot })).stdout.trim();

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-set-base-'));
    savedDryRun = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    await git('init', '-q', '-b', 'main');
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    writeFileSync(join(repoRoot, '.gitignore'), '.ai/\n');
    await git('add', '-A');
    await git(...GIT_ID, 'commit', '-q', '-m', 'base');
    // `staging` carries work `main` does not — the 149-file SPM-404 shape in miniature.
    await git('checkout', '-q', '-b', 'staging');
    writeFileSync(join(repoRoot, 'staging.txt'), 'staging only\n');
    await git('add', '-A');
    await git(...GIT_ID, 'commit', '-q', '-m', 'staging work');
    stagingSha = await git('rev-parse', 'HEAD');
    await git('checkout', '-q', 'main');
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    manager.dispose();
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const def = (graph: WorkflowGraph): WorkflowDef => {
    expect(graphIssues(graph)).toEqual([]);
    return { name: 'graph', source: 'file', steps: graphToSteps(graph), graph };
  };

  async function until(id: string, pred: (r: RunRecord) => boolean, ms = 30_000): Promise<RunRecord> {
    const deadline = Date.now() + ms;
    for (;;) {
      const r = store.getRun(id);
      if (r && pred(r)) return r;
      if (Date.now() > deadline) throw new Error(`timed out; status=${r?.status} steps=${JSON.stringify(r?.steps.map((s) => [s.id, s.status]))}`);
      await new Promise((res) => setTimeout(res, 100));
    }
  }
  const terminal = (r: RunRecord) => ['done', 'review', 'failed', 'cancelled'].includes(r.status);

  /** start → (before) → base → one marker check per port, so the port taken is readable off disk. */
  function graphWith(base: { branch: string; fallback?: string }, before?: string): WorkflowGraph {
    return {
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'read', type: 'check', command: before ?? 'echo staging' },
        { id: 'base', type: 'git.set-base', ...base },
        {
          id: 'env',
          type: 'check',
          command: 'printf "%s %s" "$CEZ_BASE_BRANCH" "$CEZ_BASE_REF" > ../env-$(basename "$PWD").txt',
        },
        { id: 'unchanged', type: 'check', command: 'printf unchanged > ../port-$(basename "$PWD").txt' },
        { id: 'refused', type: 'check', command: 'printf refused > ../port-$(basename "$PWD").txt' },
        { id: 'failed', type: 'check', command: 'printf failed > ../port-$(basename "$PWD").txt' },
      ],
      edges: [
        { from: 'start', to: 'read' },
        { from: 'read.pass', to: 'base' },
        { from: 'base.done', to: 'env' },
        { from: 'base.unchanged', to: 'unchanged' },
        { from: 'base.refused', to: 'refused' },
        { from: 'base.failed', to: 'failed' },
      ],
    };
  }
  /** Marker files land next to the worktree (`.ai/cezar/worktrees/`), outside the task's diff. */
  const marker = (r: RunRecord, kind: 'port' | 'env') =>
    readFileSync(join(r.worktreePath as string, '..', `${kind}-${r.id}.txt`), 'utf8');

  it('re-forks a pristine task onto the branch a node named, and every base surface follows', async () => {
    const id = manager.startRun(def(graphWith({ branch: '{{nodes.read.output}}' })), { task: 'SPM-404', worktree: true }).id;
    const final = await until(id, terminal);
    const wt = final.worktreePath as string;

    expect(final.baseBranch).toBe('staging');
    expect(final.graphState?.outputs?.base).toEqual({ base: 'staging', previous: 'main' });
    // The task branch now sits on staging — its work is the starting point, not part of the diff.
    expect(existsSync(join(wt, 'staging.txt'))).toBe(true);
    expect((await run('git', ['rev-parse', 'HEAD'], { cwd: wt })).stdout.trim()).toBe(stagingSha);
    // A step spawned after the node sees the new base (CEZ_BASE_BRANCH/REF, cezar#12).
    expect(marker(final, 'env')).toBe(`staging ${stagingSha}`);
    // The diff anchor follows: against main the task would "own" staging.txt.
    expect(final.diffStat).toEqual({ adds: 0, dels: 0, files: 0 });
    writeFileSync(join(wt, 'fix.txt'), 'the fix\n');
    expect(await worktreeShortstat(wt, final.baseBranch as string, { taskBranch: final.branch, runStartedAt: final.startedAt })).toMatchObject({ files: 1, adds: 1 });
  }, 40_000);

  it.each([
    ['a commit', `echo work > a.txt && git ${GIT_ID.join(' ')} commit -qam work`],
    ['uncommitted changes', 'echo wip > wip.txt'],
  ])('refuses — and changes nothing — once the task has %s', async (_label, before) => {
    const id = manager.startRun(def(graphWith({ branch: 'staging' }, before)), { task: 'x', worktree: true }).id;
    const final = await until(id, terminal);
    expect(marker(final, 'port')).toBe('refused');
    expect(final.baseBranch).toBe('main');
    expect(existsSync(join(final.worktreePath as string, 'staging.txt'))).toBe(false);
  }, 40_000);

  it('falls back when the branch renders empty; keeps the fork base when both are empty', async () => {
    const fallback = await until(
      manager.startRun(def(graphWith({ branch: '{{nodes.read.base}}', fallback: 'origin/staging' })), { task: 'x', worktree: true }).id,
      terminal,
    );
    expect(fallback.baseBranch).toBe('staging');
    expect(marker(fallback, 'env')).toBe(`staging ${stagingSha}`);

    const neither = await until(
      manager.startRun(def(graphWith({ branch: '{{nodes.read.base}}' })), { task: 'x', worktree: true }).id,
      terminal,
    );
    expect(marker(neither, 'port')).toBe('unchanged');
    expect(neither.baseBranch).toBe('main');

    // A reader check that printed nothing records "(no output)" — that is "no base named",
    // so it takes the fallback instead of failing as an invalid ref.
    const silent = await until(
      manager.startRun(def(graphWith({ branch: '{{nodes.read.output}}', fallback: 'staging' }, 'true')), { task: 'x', worktree: true }).id,
      terminal,
    );
    expect(silent.baseBranch).toBe('staging');
  }, 90_000);

  it('the base already in use is unchanged; an unknown or option-like branch fails', async () => {
    const same = await until(manager.startRun(def(graphWith({ branch: 'main' })), { task: 'x', worktree: true }).id, terminal);
    expect(marker(same, 'port')).toBe('unchanged');

    for (const branch of ['no-such-branch', '--upload-pack=touch pwned']) {
      const bad = await until(manager.startRun(def(graphWith({ branch })), { task: 'x', worktree: true }).id, terminal);
      expect(marker(bad, 'port')).toBe('failed');
      expect(bad.baseBranch).toBe('main');
    }
    expect(existsSync(join(repoRoot, 'pwned'))).toBe(false);
  }, 60_000);
});
