import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { z } from 'zod';
import { previewPortsPath } from '../paths.ts';
import { atomicWriteJsonSync } from '../workspace/config.ts';

/**
 * Host-port allocation for preview environments (spec 2026-11-24-preview-environments).
 *
 * The ledger (`~/.cezar/previews.json`) is workspace-wide and derived: every writer re-reads it
 * right before writing (the `mergeWriteAgentAccounts` bargain), a missing or corrupt file means
 * "nothing allocated", and a write that fails (read-only home) degrades to an in-memory answer —
 * the `listen()` probe is what actually keeps two previews off one port.
 */

const allocationSchema = z.object({
  port: z.number().int().min(1).max(65535),
  runId: z.string().min(1),
  /** `docker compose -p` name, so a reconcile can match an allocation to containers. */
  composeProject: z.string().min(1),
  at: z.string(),
});
/** A preview another project's build stopped to stay under `CEZ_PREVIEW_MAX`: its own project's
 *  reaper reads this to mark the record stopped (`limit`), since only it owns that store. */
const evictionSchema = z.object({ runId: z.string().min(1), at: z.string() });
const ledgerSchema = z
  .object({ allocations: z.array(allocationSchema).catch([]), evicted: z.array(evictionSchema).catch([]).optional() })
  .passthrough();

export type PortAllocation = z.infer<typeof allocationSchema>;
type Ledger = z.infer<typeof ledgerSchema>;

export const DEFAULT_PORT_RANGE = { from: 41000, to: 41999 } as const;

/** `CEZ_PREVIEW_PORTS=41000-41999`. A malformed value falls back to the default, with no error:
 *  a typo in an optional knob must not take previews down. */
export function previewPortRange(env: NodeJS.ProcessEnv = process.env): { from: number; to: number } {
  const m = /^\s*(\d{2,5})\s*-\s*(\d{2,5})\s*$/.exec(env.CEZ_PREVIEW_PORTS ?? '');
  if (!m) return { ...DEFAULT_PORT_RANGE };
  const from = Number(m[1]);
  const to = Number(m[2]);
  if (from < 1024 || to > 65535 || from > to) return { ...DEFAULT_PORT_RANGE };
  return { from, to };
}

function readLedger(): Ledger {
  try {
    const parsed = ledgerSchema.safeParse(JSON.parse(readFileSync(previewPortsPath(), 'utf8')));
    return parsed.success ? parsed.data : { allocations: [] };
  } catch {
    return { allocations: [] };
  }
}

function writeLedger(ledger: Ledger): void {
  try {
    atomicWriteJsonSync(previewPortsPath(), ledger);
  } catch {
    // Read-only home: the probe below still protects the ports; the ledger is an optimisation.
  }
}

export function listAllocations(): PortAllocation[] {
  return readLedger().allocations;
}

/** True when nothing on this machine listens on `port` at `host`. */
export function isPortFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

export interface AllocateOptions {
  runId: string;
  composeProject: string;
  count: number;
  /** Interface the ports will be published on; the probe listens there. */
  host: string;
  range?: { from: number; to: number };
  probe?: (port: number, host: string) => Promise<boolean>;
  now?: () => string;
}

/**
 * `count` host ports for one preview. A run that already holds exactly `count` ports keeps them —
 * a Restart then serves the same URLs, which is what a tester who bookmarked one expects. Their
 * containers are down by then, so they are not re-probed. Returns null when the range is full.
 */
export async function allocatePorts(opts: AllocateOptions): Promise<number[] | null> {
  const range = opts.range ?? previewPortRange();
  const probe = opts.probe ?? isPortFree;
  const now = opts.now ?? (() => new Date().toISOString());
  const ledger = readLedger();
  const mine = ledger.allocations.filter((a) => a.runId === opts.runId).map((a) => a.port);
  if (mine.length === opts.count) return [...mine].sort((a, b) => a - b);

  const taken = new Set(ledger.allocations.filter((a) => a.runId !== opts.runId).map((a) => a.port));
  const picked: number[] = [];
  for (let port = range.from; port <= range.to && picked.length < opts.count; port++) {
    if (taken.has(port)) continue;
    if (await probe(port, opts.host)) picked.push(port);
  }
  if (picked.length < opts.count) return null;

  // Re-read before writing so a concurrent allocation from another project is not dropped.
  const fresh = readLedger();
  const clash = fresh.allocations.some((a) => a.runId !== opts.runId && picked.includes(a.port));
  if (clash) return allocatePorts(opts);
  const at = now();
  writeLedger({
    ...fresh,
    allocations: [
      ...fresh.allocations.filter((a) => a.runId !== opts.runId),
      ...picked.map((port) => ({ port, runId: opts.runId, composeProject: opts.composeProject, at })),
    ],
  });
  return picked;
}

/** Give a run's ports back. Idempotent. */
export function releasePorts(runId: string): void {
  const ledger = readLedger();
  if (!ledger.allocations.some((a) => a.runId === runId)) return;
  writeLedger({ ...ledger, allocations: ledger.allocations.filter((a) => a.runId !== runId) });
}

export const DEFAULT_PREVIEW_MAX = 4;

/** `CEZ_PREVIEW_MAX` — previews that may hold ports at once, workspace-wide. */
export function previewMax(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.CEZ_PREVIEW_MAX);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_PREVIEW_MAX;
}

/** One entry per preview holding ports, oldest first. */
export function previewsHoldingPorts(): { runId: string; composeProject: string; at: string }[] {
  const byRun = new Map<string, { runId: string; composeProject: string; at: string }>();
  for (const a of readLedger().allocations) {
    const seen = byRun.get(a.runId);
    if (!seen || a.at < seen.at) byRun.set(a.runId, { runId: a.runId, composeProject: a.composeProject, at: a.at });
  }
  return [...byRun.values()].sort((a, b) => a.at.localeCompare(b.at));
}

/** Record that `runId`'s preview was stopped from outside its own project. */
export function markEvicted(runId: string, now: () => string = () => new Date().toISOString()): void {
  const ledger = readLedger();
  writeLedger({ ...ledger, evicted: [...(ledger.evicted ?? []).filter((e) => e.runId !== runId), { runId, at: now() }].slice(-200) });
}

/** True (once) when `runId` was evicted by another project; the mark is consumed. */
export function takeEviction(runId: string): boolean {
  const ledger = readLedger();
  if (!ledger.evicted?.some((e) => e.runId === runId)) return false;
  writeLedger({ ...ledger, evicted: ledger.evicted.filter((e) => e.runId !== runId) });
  return true;
}
