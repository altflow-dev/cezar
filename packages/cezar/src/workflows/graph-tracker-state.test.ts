import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { TrackerStateClient } from '../server/tracker/youtrack-state.ts';
import type { WorkflowGraph } from './graph.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

/**
 * Spec 2026-11-26-workflow-tracker-state: `tracker.set-state` moves the task's ticket when work
 * starts, and a cancel puts it back — only while it still sits where cezar put it.
 */
describe('tracker.set-state', () => {
  const saved: Record<string, string | undefined> = {};
  let repo: string;
  let store: RunStore;
  let manager: RunManager;
  let ticket: string;
  const sets: string[] = [];

  const client: TrackerStateClient = {
    get: async () => ({ ok: true, value: ticket }),
    set: async (_root, _issue, state) => {
      sets.push(state);
      ticket = state;
      return { ok: true, value: true };
    },
  };

  beforeEach(() => {
    for (const key of ['CEZ_DRY_RUN', 'CEZ_HOME']) saved[key] = process.env[key];
    delete process.env.CEZ_DRY_RUN;
    repo = mkdtempSync(join(realpathSync(tmpdir()), 'cez-ticket-state-'));
    process.env.CEZ_HOME = join(repo, '.home');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    writeFileSync(join(repo, 'a.txt'), '1\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@l', 'commit', '-qm', 'base'], { cwd: repo });
    store = RunStore.open(join(repo, '.ai/cezar'));
    manager = new RunManager(store, repo, { trackerState: client });
    ticket = 'Submitted';
    sets.length = 0;
  });

  afterEach(() => {
    manager.dispose();
    store.flush();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(repo, { recursive: true, force: true });
  });

  // start → take ticket → a human gate that parks the run, so the test can cancel it mid-flight.
  const workflow = (): WorkflowDef => {
    const graph: WorkflowGraph = {
      version: 2,
      name: 'take-ticket',
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'take', type: 'tracker.set-state', state: 'In Progress' },
        { id: 'hold', type: 'gate.human', message: 'hold' },
        { id: 'done', type: 'end', status: 'success' },
      ],
      edges: [
        { from: 'start', to: 'take' },
        { from: 'take.done', to: 'hold' },
        { from: 'take.unchanged', to: 'hold' },
        { from: 'take.failed', to: 'hold' },
        { from: 'hold.approve', to: 'done' },
        { from: 'hold.reject', to: 'done' },
      ],
    } as WorkflowGraph;
    return { name: 'take-ticket', source: 'file', steps: [], graph } as unknown as WorkflowDef;
  };

  const until = async (id: string, done: () => boolean) => {
    const deadline = Date.now() + 15_000;
    while (!done()) {
      if (Date.now() > deadline) throw new Error(`timed out; status=${store.getRun(id)?.status}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  const start = async (withTicket = true) => {
    const id = manager.startRun(workflow(), {
      task: 'SPM-405',
      worktree: false,
      ...(withTicket ? { trackerItem: { kind: 'youtrack' as const, id: 'SPM-405', url: 'https://acme.youtrack.cloud/issue/SPM-405' } } : {}),
    }).id;
    await until(id, () => store.getRun(id)?.status === 'waiting');
    return id;
  };

  it('moves the ticket when the work starts and puts it back on cancel', async () => {
    const id = await start();
    expect(ticket).toBe('In Progress');
    expect(store.getRun(id)?.trackerState).toEqual({ issue: 'SPM-405', previous: 'Submitted', state: 'In Progress' });

    manager.cancel(id);
    await until(id, () => Boolean(store.getRun(id)?.trackerState?.restoredAt));
    expect(ticket).toBe('Submitted');
    expect(sets).toEqual(['In Progress', 'Submitted']);
  });

  it('leaves a ticket someone moved since — it is theirs now', async () => {
    const id = await start();
    ticket = 'Fixed';
    manager.cancel(id);
    await new Promise((r) => setTimeout(r, 300));
    expect(ticket).toBe('Fixed');
    expect(sets).toEqual(['In Progress']);
    expect(store.getRun(id)?.trackerState?.restoredAt).toBeUndefined();
  });

  it('a ticket already in the state is not recorded, so a cancel never moves it', async () => {
    ticket = 'In Progress';
    const id = await start();
    expect(store.getRun(id)?.trackerState).toBeUndefined();
    manager.cancel(id);
    await new Promise((r) => setTimeout(r, 300));
    expect(sets).toEqual([]);
    expect(ticket).toBe('In Progress');
  });

  it('a task not launched from a ticket changes nothing', async () => {
    const id = await start(false);
    expect(sets).toEqual([]);
    expect(store.getRun(id)?.trackerState).toBeUndefined();
  });
});
