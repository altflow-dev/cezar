import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PreviewState } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import type { DockerExec } from './engine.ts';
import { PreviewReaper, stopReasonFor } from './reaper.ts';
import { markEvicted } from './ports.ts';

/**
 * Every road out of a live preview (spec 2026-11-24-preview-environments § Lifecycle). These are
 * the regression tests for "a stack nobody stops": each one is red without the reaper.
 */

let dir: string;
let store: RunStore;
let downs: string[];
let reaper: PreviewReaper | undefined;
const exec: DockerExec = async (args) => {
  if (args.includes('down')) downs.push(args[2] as string);
  if (args.includes('ls')) return { code: 0, stdout: JSON.stringify([{ Name: 'cez-p-alive' }]), stderr: '' };
  return { code: 0, stdout: '', stderr: '' };
};
const flush = () => new Promise((r) => setTimeout(r, 10));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cez-reaper-'));
  store = RunStore.open(join(dir, '.ai/cezar'));
  downs = [];
});
afterEach(() => {
  reaper?.dispose();
  reaper = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function live(project: string, over: Partial<PreviewState> = {}): PreviewState {
  return {
    status: 'ready',
    composeProject: project,
    ports: [{ label: 'web', service: 'web', hostPort: 41000, path: '/' }],
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...over,
  };
}

function runWithPreview(project: string, over: Partial<PreviewState> = {}): string {
  const run = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] } as never);
  store.updateRun(run.id, { worktreePath: join(dir, 'wt', run.id), branch: `cez/${run.id.slice(0, 8)}`, preview: live(project, over) });
  return run.id;
}

const start = () => (reaper = new PreviewReaper(store, dir, { exec, reconcile: false, dryRun: false }));

describe('PreviewReaper', () => {
  it('stops the preview when its task is archived', async () => {
    const id = runWithPreview('cez-p-a');
    start();
    store.setArchived(id, true);
    await flush();
    expect(downs).toEqual(['cez-p-a']);
    expect(store.getRun(id)?.preview).toMatchObject({ status: 'stopped', stopReason: 'archived' });
  });

  it('stops it when the bulk "archive finished" sweeps the task', async () => {
    const id = runWithPreview('cez-p-b');
    store.updateRun(id, { status: 'done' });
    start();
    store.archiveFinished();
    await flush();
    expect(downs).toEqual(['cez-p-b']);
  });

  it('stops it when the task is deleted (the record is gone by then)', async () => {
    const id = runWithPreview('cez-p-c');
    start();
    store.deleteRun(id);
    await flush();
    expect(downs).toEqual(['cez-p-c']);
  });

  it('stops it when the worktree is removed or reclaimed', async () => {
    const a = runWithPreview('cez-p-d');
    const b = runWithPreview('cez-p-e');
    start();
    store.updateRun(a, { worktreePath: undefined, branch: undefined });
    store.updateRun(b, { worktreeReclaimedAt: new Date().toISOString() });
    await flush();
    expect(downs.sort()).toEqual(['cez-p-d', 'cez-p-e']);
    expect(store.getRun(a)?.preview?.stopReason).toBe('worktree-removed');
  });

  it('stops it when its TTL runs out, on the sweep armed at construction', async () => {
    const id = runWithPreview('cez-p-f', { expiresAt: new Date(Date.now() + 40).toISOString() });
    reaper = new PreviewReaper(store, dir, { exec, reconcile: false, dryRun: false, intervalMs: 20 });
    await new Promise((r) => setTimeout(r, 120));
    expect(downs).toEqual(['cez-p-f']);
    expect(store.getRun(id)?.preview?.stopReason).toBe('ttl');
  });

  it('a preview expired while cezar was down stops at boot', async () => {
    const id = runWithPreview('cez-p-g', { expiresAt: new Date(Date.now() - 1).toISOString() });
    start();
    await flush();
    expect(store.getRun(id)?.preview?.stopReason).toBe('ttl');
  });

  it('the Stop button stops it once, however often it is pressed', async () => {
    const id = runWithPreview('cez-p-h');
    start();
    await Promise.all([reaper!.stop(id, 'user'), reaper!.stop(id, 'user')]);
    expect(downs).toEqual(['cez-p-h']);
    expect(store.getRun(id)?.preview?.stopReason).toBe('user');
  });

  it('leaves a healthy, unarchived preview running (guard: no over-eager teardown)', async () => {
    const id = runWithPreview('cez-p-i');
    start();
    store.updateRun(id, { title: 'renamed' });
    reaper!.sweep();
    await flush();
    expect(downs).toEqual([]);
    expect(store.getRun(id)?.preview?.status).toBe('ready');
  });

  it('reconcile marks a preview whose containers vanished as stopped (boot-missing), and keeps one that is up', async () => {
    const gone = runWithPreview('cez-p-gone');
    const alive = runWithPreview('cez-p-alive');
    start();
    await reaper!.reconcile();
    expect(store.getRun(gone)?.preview).toMatchObject({ status: 'stopped', stopReason: 'boot-missing' });
    expect(store.getRun(alive)?.preview?.status).toBe('ready');
  });
});

describe('PreviewReaper — the review is over, or the code moved', () => {
  it('stops the preview once the task PR is merged or closed (cache-only state)', async () => {
    const id = runWithPreview('cez-p-pr');
    store.updateRun(id, { pullRequestUrl: 'https://github.com/o/r/pull/7' });
    let state: 'open' | 'merged' = 'open';
    reaper = new PreviewReaper(store, dir, { exec, reconcile: false, dryRun: false, prState: () => state });
    reaper.sweep();
    await flush();
    expect(downs).toEqual([]);
    state = 'merged';
    reaper.sweep();
    await flush();
    expect(downs).toEqual(['cez-p-pr']);
    expect(store.getRun(id)?.preview?.stopReason).toBe('merged');
  });

  it('marks it stale when the files move past the build — at turn end — and never rebuilds it', async () => {
    const id = runWithPreview('cez-p-st', { builtFromTree: 'aaa' });
    let head = 'aaa';
    reaper = new PreviewReaper(store, dir, { exec, reconcile: false, dryRun: false, fingerprint: async () => head });
    store.updateRun(id, { status: 'running' });
    store.updateRun(id, { status: 'review' });
    await flush();
    expect(store.getRun(id)?.preview?.status).toBe('ready');
    head = 'bbb';
    store.updateRun(id, { status: 'running' });
    store.updateRun(id, { status: 'review' });
    await flush();
    expect(store.getRun(id)?.preview?.status).toBe('stale');
    expect(downs).toEqual([]);
  });

  it('records a stop another project made to stay under the limit', async () => {
    const id = runWithPreview('cez-p-ev');
    start();
    markEvicted(id);
    reaper!.sweep();
    await flush();
    expect(store.getRun(id)?.preview).toMatchObject({ status: 'stopped', stopReason: 'limit' });
    expect(downs).toEqual([]); // the other project already took it down
  });
});

describe('PreviewReaper — boot reconcile of orphaned stacks', () => {
  it("takes down this project's stacks no record owns, and leaves owned and foreign ones alone", async () => {
    const owned = runWithPreview('cez-p-0wned00');
    const ls: DockerExec = async (args) => {
      if (args.includes('down')) downs.push(args[2] as string);
      if (args.includes('ls')) return { code: 0, stdout: JSON.stringify([{ Name: 'cez-p-0wned00' }, { Name: 'cez-p-0rphan1' }, { Name: 'cez-p-two-abcdef12' }, { Name: 'cez-other-x' }, { Name: 'altflow' }]), stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    reaper = new PreviewReaper(store, dir, { exec: ls, reconcile: false, dryRun: false, composePrefix: 'cez-p-' });
    await reaper.reconcile();
    // `cez-p-two-…` belongs to project `p-two`, not to `p`.
    expect(downs).toEqual(['cez-p-0rphan1']);
    expect(store.getRun(owned)?.preview?.status).toBe('ready');
  });
});

describe('stopReasonFor', () => {
  it('ignores a run with no live preview', () => {
    expect(stopReasonFor({ archived: true } as never, new Date())).toBeUndefined();
    expect(stopReasonFor({ archived: true, preview: live('x', { status: 'failed' }) } as never, new Date())).toBeUndefined();
  });
});
