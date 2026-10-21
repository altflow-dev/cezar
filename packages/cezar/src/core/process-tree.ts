import { ChildProcess, execFileSync } from 'node:child_process';

/**
 * Signal an agent CLI together with everything it spawned.
 *
 * `child.kill()` reaches only the CLI. A Cursor or Claude session that is waiting on a tool —
 * `scripts/agent-verify.sh`, and under it `docker compose run … pytest` — keeps those running
 * after the CLI is gone: three medicore tasks killed at the 30-min Cursor turn limit left their
 * test containers running for minutes afterwards and a verify script that never ran its cleanup
 * (its machine-wide lock stayed behind and queued every later task).
 *
 * So at the moment of the kill we take ONE `ps` snapshot, walk the agent's descendants and signal
 * them deepest first, then the agent itself. SIGTERM reaching `docker compose run` is forwarded to
 * the container (it stops), and a bash script receiving SIGTERM still runs its EXIT trap.
 *
 * Only a real `ChildProcess` is walked; anything else is signalled alone.
 *
 * Deliberately not a process group (`detached: true` + `kill(-pid)`): a detached agent would no
 * longer die with cezar on Ctrl+C. Best effort and never throws: without `ps` (Windows) or when the
 * snapshot fails it falls back to signalling the child alone, which is the old behaviour.
 */

/** Parse `ps -axo pid=,ppid=` output into child lists keyed by parent pid. */
export function childrenByParent(psOutput: string): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const row of psOutput.split('\n')) {
    const [pidText, ppidText] = row.trim().split(/\s+/);
    const pid = Number(pidText);
    const ppid = Number(ppidText);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || pid <= 0) continue;
    const list = children.get(ppid);
    if (list) list.push(pid);
    else children.set(ppid, [pid]);
  }
  return children;
}

/** Every descendant of `rootPid`, deepest first (a parent always after its children). */
export function descendantsDeepestFirst(children: Map<number, number[]>, rootPid: number): number[] {
  const order: number[] = [];
  const seen = new Set<number>([rootPid]);
  const visit = (pid: number): void => {
    for (const kid of children.get(pid) ?? []) {
      if (seen.has(kid)) continue;
      seen.add(kid);
      visit(kid);
      order.push(kid);
    }
  };
  visit(rootPid);
  return order;
}

function snapshot(): Map<number, number[]> | null {
  if (process.platform === 'win32') return null;
  try {
    return childrenByParent(execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 5_000 }));
  } catch {
    return null;
  }
}

/**
 * Signal `child` and all of its descendants; returns the descendant pids it signalled. Pass that
 * list back as `known` when escalating (SIGTERM → SIGKILL): by then a descendant whose parent
 * already exited has been reparented away from the tree, and a fresh snapshot would miss it.
 * Never throws.
 */
export function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals, known: readonly number[] = []): number[] {
  // Only a process Node really spawned has a tree worth walking. A stand-in (the runner tests'
  // EventEmitter children carry made-up pids such as 4242) must never send signals to whatever
  // real process happens to own that pid on the machine.
  const root = child instanceof ChildProcess ? child.pid : undefined;
  const tree = root ? snapshot() : null;
  const pids = [...new Set([...(root && tree ? descendantsDeepestFirst(tree, root) : []), ...known])];
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
  try {
    child.kill(signal);
  } catch {
    /* already gone */
  }
  return pids;
}
