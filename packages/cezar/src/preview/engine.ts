import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { PreviewCredential, PreviewPort, PreviewState } from '@open-mercato/cezar-contract';
import { createCheckOutputCollector } from '../workflows/check-output.ts';
import { loadPreviewConfig, type PreviewConfig, type RepoFileReader } from './config.ts';
import { lintComposeModel, planPorts, renderOverride, renderServiceEnv, type ComposeModel } from './compose-model.ts';
import { allocatePorts, previewPortRange, releasePorts } from './ports.ts';

/**
 * Stand a task's app up in docker on ports of its own, and take it down again (spec
 * 2026-11-24-preview-environments). Never throws: every failure is `{ ok: false, error }`
 * with the tail of what docker printed, and a failed `up` always runs `down` and gives its
 * ports back, so a failure leaves nothing running.
 */

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export interface ExecOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  onOutput?: (text: string) => void;
}
export type DockerExec = (args: string[], opts: ExecOptions) => Promise<ExecResult>;

/** `docker <args>`. A timeout or an abort kills it; the result's code is then -1. */
export const spawnDocker: DockerExec = (args, opts) =>
  new Promise((resolveExec) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', kill);
      resolveExec(r);
    };
    const child = spawn('docker', args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const kill = () => child.kill('SIGTERM');
    const timer = opts.timeoutMs ? setTimeout(kill, opts.timeoutMs) : undefined;
    opts.signal?.addEventListener('abort', kill, { once: true });
    child.stdout.on('data', (b: Buffer) => {
      const t = b.toString('utf8');
      stdout += t;
      opts.onOutput?.(t);
    });
    child.stderr.on('data', (b: Buffer) => {
      const t = b.toString('utf8');
      stderr += t;
      opts.onOutput?.(t);
    });
    child.on('error', (err) => done({ code: -1, stdout, stderr: `${stderr}${err.message}` }));
    child.on('close', (code) => done({ code: code ?? -1, stdout, stderr }));
  });

/** compose ≥ 2.24 understands the `!reset` / `!override` tags the override relies on. */
export function composeVersionOk(version: string): boolean {
  const m = /(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > 2 || (major === 2 && minor >= 24);
}

/** `cez-<project>-<id8>`: compose project names are lowercase `[a-z0-9_-]`. */
export function composeProjectName(projectSlug: string, runId: string): string {
  const slug = projectSlug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'project';
  return `cez-${slug}-${runId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase()}`;
}

/** Where to probe a published port from this machine: a wildcard bind answers on loopback. */
export function probeHost(bind: string): string {
  if (bind === '0.0.0.0' || bind === '') return '127.0.0.1';
  if (bind === '::') return '::1';
  return bind;
}

export const PREVIEW_BUILD_TIMEOUT_MS = 15 * 60_000;

export function previewTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const hours = Number(env.CEZ_PREVIEW_TTL_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : 24) * 60 * 60_000;
}

export interface PreviewUpInput {
  runId: string;
  projectSlug: string;
  /** The project checkout — where `copyFromRoot` files come from. */
  repoRoot: string;
  /** The task worktree — the build context. */
  worktree: string;
  /** cezar's `.ai/cezar` for this project — the override and the base-branch config copies. */
  dataDir: string;
  /** Ref the trusted config is read from (the task's base). */
  baseRef: string;
  trustWorktreeConfig: boolean;
  /** Interface to publish on. */
  bind: string;
  /** The host the app should name for itself (`{host}`); `localhost` when omitted. */
  publicHost?: string;
  notes?: string;
  changedFiles?: string[];
  builtFromSha?: string;
  builtFromTree?: string;
  exec?: DockerExec;
  /** `git show <ref>:<path>` in the worktree; injectable for tests. */
  readAtRef?: (ref: string, path: string) => Promise<string | null>;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onLog?: (text: string) => void;
  now?: () => Date;
  dryRun?: boolean;
}

export type PreviewUpResult =
  | { ok: true; state: PreviewState; warnings: string[] }
  | { ok: false; error: string; output: string };

function worktreeReader(worktree: string): RepoFileReader {
  return async (path) => {
    const abs = resolve(worktree, path);
    try {
      return statSync(abs).isFile() ? readFileSync(abs, 'utf8') : null;
    } catch {
      return null;
    }
  };
}

async function gitShow(cwd: string, ref: string, path: string): Promise<string | null> {
  return new Promise((resolveShow) => {
    const child = spawn('git', ['show', `${ref}:${path}`], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (b: Buffer) => (out += b.toString('utf8')));
    child.on('error', () => resolveShow(null));
    child.on('close', (code) => resolveShow(code === 0 ? out : null));
  });
}

function parseModel(stdout: string): ComposeModel | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return parsed && typeof parsed === 'object' ? (parsed as ComposeModel) : null;
  } catch {
    return null;
  }
}

const tail = (text: string, lines = 60) => text.trim().split('\n').slice(-lines).join('\n');

/** A run of up/down/logs against one compose project. */
export interface ComposeTarget {
  composeProject: string;
  /** cwd for docker — the worktree, or the repo when the worktree is gone. */
  cwd: string;
}

export async function previewDown(target: ComposeTarget, runId: string, exec: DockerExec = spawnDocker, dryRun = process.env.CEZ_DRY_RUN === '1'): Promise<{ ok: boolean; error?: string }> {
  try {
    if (dryRun) return { ok: true };
    // Addressed by project name alone: `down -p` needs no compose file, so it works after the
    // worktree is gone. `--rmi local` drops the images this stack built, or the disk fills.
    const res = await exec(['compose', '-p', target.composeProject, 'down', '-v', '--remove-orphans', '--rmi', 'local'], {
      cwd: existsSync(target.cwd) ? target.cwd : '/',
      timeoutMs: 3 * 60_000,
    });
    return res.code === 0 ? { ok: true } : { ok: false, error: tail(res.stderr || res.stdout, 10) };
  } finally {
    releasePorts(runId);
  }
}

export async function previewLogs(target: ComposeTarget, service: string | undefined, tailLines: number, exec: DockerExec = spawnDocker): Promise<string> {
  const res = await exec(['compose', '-p', target.composeProject, 'logs', '--no-color', '--tail', String(tailLines), ...(service ? [service] : [])], {
    cwd: existsSync(target.cwd) ? target.cwd : '/',
    timeoutMs: 30_000,
  });
  return (res.stdout + res.stderr).slice(-200_000);
}

/** Copy gitignored files (`.env`…) the worktree lacks from the project checkout. Never overwrites. */
export function copyFromRoot(repoRoot: string, worktree: string, paths: string[]): string[] {
  const notes: string[] = [];
  for (const p of paths) {
    const src = resolve(repoRoot, p);
    const dst = resolve(worktree, p);
    if (!existsSync(src)) {
      notes.push(`copyFromRoot: ${p} does not exist in the project checkout — skipped`);
      continue;
    }
    if (existsSync(dst)) continue;
    try {
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      notes.push(`copied ${p} from the project checkout`);
    } catch (err) {
      notes.push(`copyFromRoot: could not copy ${p} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return notes;
}

function stateFor(
  input: PreviewUpInput,
  composeProject: string,
  ports: PreviewPort[],
  config: PreviewConfig,
  startedAt: Date,
): PreviewState {
  const now = (input.now ?? (() => new Date()))();
  const credentials: PreviewCredential[] | undefined = config.credentials?.map((c) => ({
    label: c.label,
    ...(c.url ? { url: c.url } : {}),
    user: c.user,
    password: c.password,
  }));
  return {
    status: 'ready',
    composeProject,
    ports,
    ...(input.publicHost ? { host: input.publicHost } : {}),
    ...(credentials?.length ? { credentials } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
    ...(input.changedFiles?.length ? { changedFiles: input.changedFiles } : {}),
    ...(input.builtFromSha ? { builtFromSha: input.builtFromSha } : {}),
    ...(input.builtFromTree ? { builtFromTree: input.builtFromTree } : {}),
    startedAt: startedAt.toISOString(),
    readyAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + previewTtlMs()).toISOString(),
  };
}

export async function previewUp(input: PreviewUpInput): Promise<PreviewUpResult> {
  const exec = input.exec ?? spawnDocker;
  const log = input.onLog ?? (() => undefined);
  const startedAt = (input.now ?? (() => new Date()))();
  const composeProject = composeProjectName(input.projectSlug, input.runId);
  const output = createCheckOutputCollector();
  const say = (text: string) => {
    output.push(text);
    log(text);
  };
  const fail = (error: string): PreviewUpResult => ({ ok: false, error, output: output.text().trim() || error });
  const readAtRef = input.readAtRef ?? ((ref, path) => gitShow(input.worktree, ref, path));
  const reader: RepoFileReader = input.trustWorktreeConfig ? worktreeReader(input.worktree) : (path) => readAtRef(input.baseRef, path);

  const loaded = await loadPreviewConfig(reader);
  if (!loaded.ok) return fail(loaded.error);
  const { config, warnings } = loaded;
  if (!input.trustWorktreeConfig) say(`config read from ${input.baseRef} (the task branch's own compose changes are not used — set trustWorktreeConfig to use them)\n`);

  if (input.dryRun) {
    const labels = Object.keys(config.expose ?? {}).length ? Object.entries(config.expose ?? {}).map(([label, e]) => ({ label, service: e.service, path: e.path })) : [{ label: 'app', service: 'app', path: '/' }];
    const hostPorts = await allocatePorts({ runId: input.runId, composeProject, count: labels.length, host: probeHost(input.bind), probe: async () => true });
    if (!hostPorts) return fail(`no free ports left in ${JSON.stringify(previewPortRange())}`);
    say('dry run — docker not touched\n');
    return { ok: true, warnings, state: stateFor(input, composeProject, labels.map((l, i) => ({ ...l, hostPort: hostPorts[i] as number })), config, startedAt) };
  }

  const version = await exec(['compose', 'version', '--short'], { cwd: input.worktree, timeoutMs: 20_000 });
  if (version.code !== 0) return fail(`docker compose is not available on this machine — ${tail(version.stderr || version.stdout, 3) || 'install Docker with the compose plugin'}`);
  if (!composeVersionOk(version.stdout)) return fail(`docker compose ${version.stdout.trim()} is too old — previews need 2.24 or newer`);

  // Compose files: the worktree's own when trusted, else copies of the base branch's, run with
  // the worktree as the project directory so every relative path still means the task's code.
  const previewDir = join(input.dataDir, 'previews', input.runId);
  mkdirSync(previewDir, { recursive: true });
  const projectDir = resolve(input.worktree, dirname(loaded.composeFiles[0] as string));
  const files: string[] = [];
  for (const f of loaded.composeFiles) {
    if (input.trustWorktreeConfig) {
      files.push(resolve(input.worktree, f));
      continue;
    }
    const text = await reader(f);
    if (text === null) return fail(`compose file "${f}" vanished from ${input.baseRef}`);
    const copy = join(previewDir, 'base', f);
    mkdirSync(dirname(copy), { recursive: true });
    writeFileSync(copy, text);
    files.push(copy);
  }

  for (const note of copyFromRoot(input.repoRoot, input.worktree, config.copyFromRoot ?? [])) say(`${note}\n`);

  const env = { ...process.env, ...(config.env ?? {}) };
  const base = ['compose', '-p', composeProject, '--project-directory', projectDir];
  const withFiles = (extra: string[] = []) => [...base, ...[...files, ...extra].flatMap((f) => ['-f', f])];
  const opts = (timeoutMs: number, stream = false): ExecOptions => ({
    cwd: input.worktree,
    env,
    timeoutMs,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(stream ? { onOutput: say } : {}),
  });

  const first = await exec([...withFiles(), 'config', '--format', 'json'], opts(60_000));
  if (first.code !== 0) return fail(`docker compose config failed:\n${tail(first.stderr || first.stdout, 20)}`);
  const model = parseModel(first.stdout);
  if (!model) return fail('docker compose config printed something that is not JSON');
  const plan = planPorts(model, config);
  if (!plan.ok) return fail(plan.error);

  const hostPorts = await allocatePorts({ runId: input.runId, composeProject, count: plan.ports.length, host: probeHost(input.bind) });
  if (!hostPorts) return fail(`no free ports left in ${JSON.stringify(previewPortRange())} — stop an older preview or widen CEZ_PREVIEW_PORTS`);

  const teardown = async (error: string): Promise<PreviewUpResult> => {
    await previewDown({ composeProject, cwd: input.worktree }, input.runId, exec, false);
    return fail(error);
  };

  const publicHost = input.publicHost ?? 'localhost';
  const envPlan = renderServiceEnv(
    config.serviceEnv,
    model.services ?? {},
    plan.ports.map((p, i) => ({ label: p.label, path: p.path, hostPort: hostPorts[i] as number })),
    publicHost,
  );
  if (!envPlan.ok) {
    releasePorts(input.runId);
    return fail(envPlan.error);
  }
  const overridePath = join(previewDir, 'override.yml');
  writeFileSync(overridePath, renderOverride(model, plan.ports, hostPorts, input.bind, envPlan.env));
  const merged = await exec([...withFiles([overridePath]), 'config', '--format', 'json'], opts(60_000));
  const mergedModel = merged.code === 0 ? parseModel(merged.stdout) : null;
  if (!mergedModel) {
    releasePorts(input.runId);
    return fail(`docker compose rejected the preview override:\n${tail(merged.stderr || merged.stdout, 20)}`);
  }
  const issues = lintComposeModel(mergedModel, input.worktree);
  if (issues.length) {
    releasePorts(input.runId);
    return fail(`refusing to start this compose file on the server:\n- ${issues.join('\n- ')}`);
  }

  const timeoutSec = config.ready?.timeoutSec ?? 300;
  say(`$ docker compose -p ${composeProject} up -d --build --wait\n`);
  const up = await exec(
    [...withFiles([overridePath]), 'up', '-d', '--build', '--wait', '--wait-timeout', String(timeoutSec), '--remove-orphans'],
    opts(PREVIEW_BUILD_TIMEOUT_MS, true),
  );
  if (input.signal?.aborted) return teardown('cancelled');
  if (up.code !== 0) {
    const logs = await previewLogs({ composeProject, cwd: input.worktree }, undefined, 80, exec).catch(() => '');
    if (logs) say(`\n--- container logs ---\n${logs}`);
    return teardown(`docker compose up failed (exit ${up.code})`);
  }

  const ports: PreviewPort[] = plan.ports.map((p, i) => ({ label: p.label, service: p.service, hostPort: hostPorts[i] as number, path: p.path }));
  const readyLabel = config.ready?.url ?? ports[0]?.label;
  const readyPort = ports.find((p) => p.label === readyLabel) ?? ports[0];
  if (readyPort) {
    const url = `http://${probeHost(input.bind).includes(':') ? `[${probeHost(input.bind)}]` : probeHost(input.bind)}:${readyPort.hostPort}${config.ready?.path ?? readyPort.path}`;
    say(`waiting for ${url}\n`);
    const ok = await waitForHttp(url, timeoutSec * 1000, input.fetchImpl ?? fetch, input.signal);
    if (!ok) return teardown(`the app did not answer on ${readyPort.label} (${url}) within ${timeoutSec}s`);
  }

  for (const s of config.seed ?? []) {
    say(`$ seed (${s.service}): ${s.command}\n`);
    const res = await exec([...withFiles([overridePath]), 'exec', '-T', s.service, 'sh', '-lc', s.command], opts(10 * 60_000, true));
    if (res.code !== 0) return teardown(`seed command failed in ${s.service} (exit ${res.code}): ${s.command}`);
  }

  return { ok: true, warnings, state: stateFor(input, composeProject, ports, config, startedAt) };
}

/** Poll until the URL answers below 500 (a login redirect or a 404 page is "up"), or time runs out. */
export async function waitForHttp(url: string, timeoutMs: number, fetchImpl: typeof fetch, signal?: AbortSignal, intervalMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    try {
      const res = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
      if (res.status < 500) return true;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}
