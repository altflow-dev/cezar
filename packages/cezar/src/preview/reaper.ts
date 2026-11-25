import type { PreviewState, PreviewStopReason } from '@open-mercato/cezar-contract';
import type { RunRecord, RunStore } from '../runs/store.ts';
import { previewDown, spawnDocker, type DockerExec } from './engine.ts';
import { takeEviction } from './ports.ts';

/**
 * Every way a preview ends (spec 2026-11-24-preview-environments § Lifecycle), in ONE place.
 *
 * It listens to the store rather than being called from each route, because the terminal
 * transitions are many and scattered — the archive route, the bulk archive, a variant group's
 * pick, delete, "remove worktree", count-based retention — and a hook missed at one of them is
 * a stack that runs forever (AGENTS.md: grep the TYPE, not the field). The store already
 * broadcasts every one of them as a `run` or `deleted` event.
 *
 * The TTL sweep is the bounded exit for a preview nobody archives: armed at construction (that
 * is, at boot), not at the first preview, so a restart never loses it.
 */

const LIVE = new Set<PreviewState['status']>(['ready', 'stale']);
export const SWEEP_INTERVAL_MS = 5 * 60_000;

export interface PreviewReaperOptions {
  exec?: DockerExec;
  now?: () => Date;
  /** Run the boot reconcile (`docker compose ls`). Off under dry-run and in tests by default. */
  reconcile?: boolean;
  intervalMs?: number;
  dryRun?: boolean;
  /** The task PR's state as cezar already knows it (cache only — the reaper never asks the
   *  forge). `merged` or `closed` stops the preview: the review it existed for is over. */
  prState?: (run: RunRecord) => 'merged' | 'closed' | 'open' | undefined;
  /** `cez-<project>-` — this project's compose names. With it, the boot reconcile also takes
   *  down stacks of this project that no record owns any more (a crash mid-build, a run whose
   *  record was lost). Without it, foreign stacks are never touched. */
  composePrefix?: string;
  /** Fingerprint of a worktree's files (`worktreeTreeId`), for the `stale` check. */
  fingerprint?: (worktree: string) => Promise<string | undefined>;
}

export function isLivePreview(preview: PreviewState | undefined): preview is PreviewState {
  return Boolean(preview && LIVE.has(preview.status));
}

/** Why this record's preview must stop now, or undefined while it may keep running. */
export function stopReasonFor(run: RunRecord, now: Date, prState?: 'merged' | 'closed' | 'open'): PreviewStopReason | undefined {
  if (!isLivePreview(run.preview)) return undefined;
  if (run.archived) return 'archived';
  if (prState === 'merged' || prState === 'closed') return 'merged';
  if (run.worktreeReclaimedAt || (run.worktree !== false && !run.worktreePath)) return 'worktree-removed';
  if (run.preview.expiresAt && Date.parse(run.preview.expiresAt) <= now.getTime()) return 'ttl';
  return undefined;
}

export class PreviewReaper {
  private readonly exec: DockerExec;
  private readonly now: () => Date;
  private readonly prState: NonNullable<PreviewReaperOptions['prState']>;
  private readonly composePrefix: string | undefined;
  private readonly fingerprint: NonNullable<PreviewReaperOptions['fingerprint']> | undefined;
  private readonly dryRun: boolean;
  /** runId → what `down` needs after the record is gone (a `deleted` event carries only the id). */
  private readonly live = new Map<string, { composeProject: string; cwd: string }>();
  private readonly stopping = new Set<string>();
  private readonly lastStatus = new Map<string, RunRecord['status']>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly onRun = (run: RunRecord) => this.observe(run);
  private readonly onDeleted = (id: string) => void this.stopDeleted(id);

  constructor(
    private readonly store: RunStore,
    private readonly repoRoot: string,
    opts: PreviewReaperOptions = {},
  ) {
    this.exec = opts.exec ?? spawnDocker;
    this.now = opts.now ?? (() => new Date());
    this.prState = opts.prState ?? (() => undefined);
    this.composePrefix = opts.composePrefix;
    this.fingerprint = opts.fingerprint;
    this.dryRun = opts.dryRun ?? process.env.CEZ_DRY_RUN === '1';
    for (const run of store.listRuns()) this.observe(run);
    store.on('run', this.onRun);
    store.on('deleted', this.onDeleted);
    this.timer = setInterval(() => this.sweep(), opts.intervalMs ?? SWEEP_INTERVAL_MS);
    this.timer.unref?.();
    if (opts.reconcile ?? (!this.dryRun && !process.env.VITEST)) void this.reconcile();
  }

  dispose(): void {
    clearInterval(this.timer);
    this.store.off('run', this.onRun);
    this.store.off('deleted', this.onDeleted);
  }

  /** TTL, PR state, staleness (and any transition a missed event left behind). */
  sweep(): void {
    for (const run of this.store.listRuns()) {
      this.observe(run);
      void this.checkStale(run.id);
    }
  }

  /**
   * `ready` → `stale` once the worktree's FILES differ from what the preview was built from (an
   * agent turn after the build, a Continue). Files, not HEAD: cezar's own autosave commits the
   * same bytes at turn end. Not rebuilt automatically — a tester may be halfway through a
   * checklist — the card says so and offers Restart.
   */
  async checkStale(runId: string): Promise<void> {
    if (!this.fingerprint) return;
    const run = this.store.getRun(runId);
    const p = run?.preview;
    if (!run || !p || p.status !== 'ready' || !p.builtFromTree || !run.worktreePath) return;
    const tree = await this.fingerprint(run.worktreePath).catch(() => undefined);
    const now = this.store.getRun(runId);
    if (!tree || tree === p.builtFromTree || now?.preview?.status !== 'ready' || now.preview.builtFromTree !== p.builtFromTree) return;
    this.store.updateRun(runId, { preview: { ...now.preview, status: 'stale' } });
    this.store.appendEvent(runId, { type: 'note', message: 'the code changed since the preview was built — restart it to test the new version' });
  }

  /** Stop one run's preview now. Idempotent; resolves once docker answered. */
  async stop(runId: string, reason: PreviewStopReason): Promise<void> {
    const run = this.store.getRun(runId);
    const target = this.live.get(runId) ?? (run?.preview ? { composeProject: run.preview.composeProject, cwd: run.worktreePath ?? this.repoRoot } : undefined);
    if (!target || this.stopping.has(runId)) return;
    this.stopping.add(runId);
    this.live.delete(runId);
    try {
      const res = await previewDown(target, runId, this.exec, this.dryRun);
      const current = this.store.getRun(runId);
      if (current?.preview) {
        this.store.updateRun(runId, {
          preview: {
            ...current.preview,
            status: 'stopped',
            stoppedAt: this.now().toISOString(),
            stopReason: reason,
            ...(res.ok ? {} : { error: `docker compose down failed: ${res.error ?? 'unknown error'}` }),
          },
        });
        this.store.appendEvent(runId, { type: 'note', message: `preview stopped (${reason})` });
      }
    } finally {
      this.stopping.delete(runId);
    }
  }

  private observe(run: RunRecord): void {
    if (!isLivePreview(run.preview)) {
      // A record that is no longer live was stopped (by us or by the node replacing it).
      if (!this.stopping.has(run.id)) this.live.delete(run.id);
      return;
    }
    this.live.set(run.id, { composeProject: run.preview.composeProject, cwd: run.worktreePath ?? this.repoRoot });
    // A turn just ended (the run left `running`): the code may have moved under the preview.
    const prev = this.lastStatus.get(run.id);
    this.lastStatus.set(run.id, run.status);
    if (prev === 'running' && run.status !== 'running') void this.checkStale(run.id);
    const reason = stopReasonFor(run, this.now(), this.prState(run));
    if (!reason && takeEviction(run.id)) {
      // Another project's build already took it down to stay under the limit; say so here.
      this.markStopped(run.id, 'limit');
      return;
    }
    if (reason) void this.stop(run.id, reason);
  }

  /** Record a stop that already happened elsewhere (no docker call). */
  markStopped(runId: string, reason: PreviewStopReason): void {
    this.live.delete(runId);
    const current = this.store.getRun(runId);
    if (!current?.preview) return;
    this.store.updateRun(runId, { preview: { ...current.preview, status: 'stopped', stoppedAt: this.now().toISOString(), stopReason: reason } });
    this.store.appendEvent(runId, { type: 'note', message: `preview stopped (${reason})` });
  }

  private async stopDeleted(id: string): Promise<void> {
    const target = this.live.get(id);
    if (!target) return;
    this.live.delete(id);
    await previewDown(target, id, this.exec, this.dryRun).catch(() => undefined);
  }

  /** Boot: a record says `ready`, but docker has no such project (the host rebooted, someone ran
   *  `docker compose down`) — say so instead of showing dead links. */
  async reconcile(): Promise<void> {
    if (!this.live.size && !this.composePrefix) return;
    const res = await this.exec(['compose', 'ls', '--all', '--format', 'json'], { cwd: this.repoRoot, timeoutMs: 20_000 }).catch(() => null);
    if (!res || res.code !== 0) return; // no docker: nothing to reconcile against
    let names: Set<string>;
    try {
      names = new Set((JSON.parse(res.stdout) as { Name?: string }[]).map((p) => p.Name ?? ''));
    } catch {
      return;
    }
    if (this.composePrefix) {
      const owned = new Set(
        this.store
          .listRuns()
          .filter((r) => r.preview && r.preview.status !== 'stopped' && r.preview.status !== 'failed')
          .map((r) => r.preview?.composeProject),
      );
      for (const name of names) {
        // Exactly `<prefix><id8>`: a bare prefix test would let project `app` take down the stacks
        // of project `app-two` (`cez-app-two-…`), since the run-id part never contains a dash.
        if (!name.startsWith(this.composePrefix) || !/^[a-z0-9]{1,8}$/.test(name.slice(this.composePrefix.length)) || owned.has(name)) continue;
        await this.exec(['compose', '-p', name, 'down', '-v', '--remove-orphans', '--rmi', 'local'], { cwd: this.repoRoot, timeoutMs: 3 * 60_000 }).catch(() => undefined);
      }
    }
    for (const [runId, target] of [...this.live]) {
      if (names.has(target.composeProject)) continue;
      this.live.delete(runId);
      const current = this.store.getRun(runId);
      if (!current?.preview) continue;
      this.store.updateRun(runId, {
        preview: { ...current.preview, status: 'stopped', stoppedAt: this.now().toISOString(), stopReason: 'boot-missing' },
      });
    }
  }
}
