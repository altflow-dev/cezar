import { spawn, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { childrenByParent, descendantsDeepestFirst, signalProcessTree } from './process-tree.ts';
import { CursorAgentRunner } from './cursor-agent-runner.ts';

const posix = process.platform !== 'win32';
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitFor = async (check: () => boolean, ms = 5_000): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
};
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('descendantsDeepestFirst', () => {
  it('walks every descendant and lists a parent after its children', () => {
    const tree = childrenByParent(' 10 1\n 11 10\n 12 11\n 13 10\n 99 1\n junk\n');
    expect(descendantsDeepestFirst(tree, 10)).toEqual([12, 11, 13]);
    expect(descendantsDeepestFirst(tree, 99)).toEqual([]);
  });
});

describe('signalProcessTree', () => {
  it('signals only a stand-in child itself, never a pid it merely claims', () => {
    const kill = vi.fn();
    const fake = Object.assign(new EventEmitter(), { pid: process.pid, kill });
    const processKill = vi.spyOn(process, 'kill');
    try {
      expect(signalProcessTree(fake as never, 'SIGTERM')).toEqual([]);
      expect(kill).toHaveBeenCalledWith('SIGTERM');
      expect(processKill).not.toHaveBeenCalled();
    } finally {
      processKill.mockRestore();
    }
  });

  it.runIf(posix)('stops the grandchildren a plain child.kill leaves running', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-tree-'));
    dirs.push(dir);
    const pidFile = join(dir, 'grandchild.pid');
    const child = spawn('sh', ['-c', `sleep 300 & echo $! > "${pidFile}"; sleep 300`], { stdio: 'ignore' });
    expect(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '')).toBe(true);
    const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
    expect(alive(grandchild)).toBe(true);

    const signalled = signalProcessTree(child, 'SIGTERM');

    expect(signalled).toContain(grandchild);
    expect(await waitFor(() => !alive(grandchild))).toBe(true);
  });

  it.runIf(posix)('escalates to pids already reparented out of the tree', async () => {
    const orphan = spawn('sleep', ['300'], { stdio: 'ignore', detached: true });
    orphan.unref();
    const unrelated = spawn('sh', ['-c', 'sleep 300'], { stdio: 'ignore' });
    try {
      signalProcessTree(unrelated, 'SIGKILL', [orphan.pid!]);
      expect(await waitFor(() => !alive(orphan.pid!))).toBe(true);
    } finally {
      try {
        process.kill(orphan.pid!, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  });
});

describe('CursorAgentRunner timeout (the medicore case)', () => {
  it.runIf(posix)('kills the tool a timed-out turn was waiting on, not only the agent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-cursor-tree-'));
    dirs.push(dir);
    const pidFile = join(dir, 'tool.pid');
    const bin = join(dir, 'agent');
    // A stand-in `agent`: starts a long "tool" (think: agent-verify.sh → docker compose run) and
    // never finishes its turn.
    writeFileSync(bin, `#!/bin/sh\nsleep 300 &\necho $! > "${pidFile}"\nsleep 300\n`);
    chmodSync(bin, 0o755);
    const runner = new CursorAgentRunner({ bin, timeoutMs: 1_000 });
    const events: Array<{ type: string; message?: string }> = [];

    await runner.run({ userPrompt: 'verify', cwd: dir }, (e) => events.push(e as never));

    expect(events.some((e) => e.type === 'error' && /timed out/.test(e.message ?? ''))).toBe(true);
    const tool = Number(readFileSync(pidFile, 'utf8').trim());
    expect(await waitFor(() => !alive(tool))).toBe(true);
  }, 20_000);
});

// ps is what the helper relies on; make a missing one fail loudly here rather than silently.
it.runIf(posix)('ps is available for the tree snapshot', () => {
  expect(execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).length).toBeGreaterThan(0);
});
