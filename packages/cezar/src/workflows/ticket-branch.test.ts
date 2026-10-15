import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

/**
 * Spec 2026-10-15-ticket-implement-review-workflow §13, end to end through the manager: a task
 * started with a YouTrack `trackerItem` keeps it on the record, gets a `cez/<TICKET>-<id8>` branch
 * in its usual `.ai/cezar/worktrees/<runId>` directory, and cezar's own commits name the ticket.
 * The control task (no ticket) pins that nothing changed for everything else.
 */

const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const roots: string[] = [];

function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'cez-ticket-branch-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', [...GIT_ID, 'commit', '--allow-empty', '-q', '-m', 'base'], { cwd: root });
  return root;
}

async function waitDone(store: RunStore, id: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (['done', 'failed', 'cancelled', 'review'].includes(store.getRun(id)?.status ?? '')) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('run did not finish');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const workflow: WorkflowDef = {
  name: 'write-a-file',
  source: 'built-in',
  steps: [{ id: 'write', command: 'node -e "require(\'node:fs\').writeFileSync(\'out.txt\', \'x\')"' }],
};
const ticket = { kind: 'youtrack' as const, id: 'TERM-396', url: 'https://altflow.youtrack.cloud/issue/TERM-396', title: 'Fix the export' };

describe('RunManager ticket tasks', () => {
  it('records the ticket, names the branch after it and prefixes cezar commits', async () => {
    const root = fixtureRepo();
    const store = RunStore.open(join(root, '.ai/cezar'));
    const manager = new RunManager(store, root);
    try {
      const withTicket = manager.startRun(workflow, { task: 'TERM-396', trackerItem: ticket });
      const plain = manager.startRun(workflow, { task: 'plain task' });
      await waitDone(store, withTicket.id);
      await waitDone(store, plain.id);

      const a = store.getRun(withTicket.id);
      expect(a?.status).toBe('done');
      expect(a?.trackerItem).toEqual(ticket);
      expect(a?.branch).toBe(`cez/TERM-396-${withTicket.id.slice(0, 8)}`);
      expect(a?.worktreePath?.endsWith(join('.ai/cezar/worktrees', withTicket.id))).toBe(true);
      const subjectA = execFileSync('git', ['log', '-1', '--format=%s', a!.branch!], { cwd: root }).toString().trim();
      expect(subjectA).toBe('[TERM-396] cezar autosave (run finalize)');

      const b = store.getRun(plain.id);
      expect(b?.trackerItem).toBeUndefined();
      expect(b?.branch).toBe(`cez/${plain.id.slice(0, 8)}`);
      const subjectB = execFileSync('git', ['log', '-1', '--format=%s', b!.branch!], { cwd: root }).toString().trim();
      expect(subjectB).toBe('cezar autosave (run finalize)');
    } finally {
      manager.dispose();
      store.flush();
    }
  });
});
