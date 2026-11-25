import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ComposeModel } from './compose-model.ts';
import { composeProjectName, composeVersionOk, previewUp, type DockerExec, type PreviewUpInput } from './engine.ts';
import { listAllocations } from './ports.ts';

let dir: string;
let savedHome: string | undefined;
beforeEach(() => {
  savedHome = process.env.CEZ_HOME;
  dir = mkdtempSync(join(tmpdir(), 'cez-preview-'));
  process.env.CEZ_HOME = join(dir, 'home');
  for (const d of ['repo', 'wt', 'data']) mkdirSync(join(dir, d), { recursive: true });
});
afterEach(() => {
  process.env.CEZ_HOME = savedHome;
  rmSync(dir, { recursive: true, force: true });
});

const MODEL: ComposeModel = {
  services: {
    web: { ports: [{ target: 5173, published: '5173' }] },
    db: { ports: [{ target: 5432, published: '5456' }] },
  },
};
const PREVIEW_YML = [
  'expose:',
  '  frontend: { service: web, port: 5173 }',
  'seed: [{ service: web, command: "npm run seed" }]',
  'credentials: [{ label: Admin, url: frontend, user: admin, password: admin123 }]',
  'copyFromRoot: [.env]',
].join('\n');

interface FakeDocker {
  exec: DockerExec;
  calls: string[][];
}
function fakeDocker(over: { version?: string; mergedModel?: ComposeModel; upCode?: number; seedCode?: number } = {}): FakeDocker {
  const calls: string[][] = [];
  const exec: DockerExec = async (args, opts) => {
    calls.push(args);
    // Like spawnDocker: streamed commands hand their output to onOutput as it arrives.
    if (args.includes('up') && over.upCode) opts.onOutput?.('boom: Dockerfile line 3\n');
    const has = (x: string) => args.includes(x);
    if (has('version')) return { code: 0, stdout: `${over.version ?? '2.29.1'}\n`, stderr: '' };
    if (has('config')) {
      const merged = args.some((a) => a.endsWith('override.yml'));
      return { code: 0, stdout: JSON.stringify(merged ? (over.mergedModel ?? MODEL) : MODEL), stderr: '' };
    }
    if (has('up')) return { code: over.upCode ?? 0, stdout: 'built\n', stderr: over.upCode ? 'boom: Dockerfile line 3' : '' };
    if (has('exec')) return { code: over.seedCode ?? 0, stdout: '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return { exec, calls };
}

function input(docker: FakeDocker, over: Partial<PreviewUpInput> = {}): PreviewUpInput {
  const base: Record<string, string> = { '.ai/cezar/preview.yml': PREVIEW_YML, 'compose.yaml': 'services: {}' };
  return {
    runId: 'abcdef12-0000',
    projectSlug: 'Altflow Metrics',
    repoRoot: join(dir, 'repo'),
    worktree: join(dir, 'wt'),
    dataDir: join(dir, 'data'),
    baseRef: 'main',
    trustWorktreeConfig: false,
    bind: '0.0.0.0',
    exec: docker.exec,
    readAtRef: async (_ref, path) => base[path] ?? null,
    fetchImpl: (async () => new Response('ok', { status: 200 })) as typeof fetch,
    notes: '## What changed\n- x',
    ...over,
  };
}

describe('previewUp', () => {
  it('builds from the base branch config, isolates ports, waits, seeds and reports links + logins', async () => {
    writeFileSync(join(dir, 'repo', '.env'), 'SECRET=1');
    const docker = fakeDocker();
    const res = await previewUp(input(docker));
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.state).toMatchObject({
      status: 'ready',
      composeProject: 'cez-altflow-metrics-abcdef12',
      ports: [{ label: 'frontend', service: 'web', hostPort: 41000, path: '/' }],
      credentials: [{ label: 'Admin', url: 'frontend', user: 'admin', password: 'admin123' }],
      notes: '## What changed\n- x',
    });
    expect(res.state.expiresAt).toBeDefined();

    // The base branch's compose ran, with the worktree as the project directory.
    const up = docker.calls.find((a) => a.includes('up')) as string[];
    expect(up.slice(0, 5)).toEqual(['compose', '-p', 'cez-altflow-metrics-abcdef12', '--project-directory', join(dir, 'wt')]);
    expect(up).toContain(join(dir, 'data', 'previews', 'abcdef12-0000', 'base', 'compose.yaml'));
    expect(up).toEqual(expect.arrayContaining(['--build', '--wait', '-d']));

    const override = readFileSync(join(dir, 'data', 'previews', 'abcdef12-0000', 'override.yml'), 'utf8');
    expect(override).toContain('"0.0.0.0:41000:5173"');
    expect(override).toContain('"db":\n    ports: !reset []');

    expect(docker.calls.find((a) => a.includes('exec'))?.slice(-4)).toEqual(['web', 'sh', '-lc', 'npm run seed']);
    expect(readFileSync(join(dir, 'wt', '.env'), 'utf8')).toBe('SECRET=1');
    expect(listAllocations().map((a) => a.port)).toEqual([41000]);
  });

  it('with trustWorktreeConfig, reads the worktree\'s own files and never the base branch', async () => {
    writeFileSync(join(dir, 'wt', 'compose.yaml'), 'services: {}');
    const docker = fakeDocker();
    let baseReads = 0;
    const res = await previewUp(input(docker, { trustWorktreeConfig: true, readAtRef: async () => (baseReads++, null) }));
    expect(res.ok).toBe(true);
    expect(baseReads).toBe(0);
    expect(docker.calls.find((a) => a.includes('up'))).toContain(join(dir, 'wt', 'compose.yaml'));
  });

  it('refuses a compose file that reaches the host — before anything starts — and frees its ports', async () => {
    const docker = fakeDocker({ mergedModel: { services: { web: { privileged: true, ports: [{ target: 5173 }] } } } });
    const res = await previewUp(input(docker));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/refusing.*privileged/s);
    expect(docker.calls.some((a) => a.includes('up'))).toBe(false);
    expect(listAllocations()).toEqual([]);
  });

  it('a failed build tears down what it started and returns the log for the next agent', async () => {
    const docker = fakeDocker({ upCode: 1 });
    const res = await previewUp(input(docker));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/up failed/);
      expect(res.output).toContain('boom: Dockerfile line 3');
    }
    expect(docker.calls.some((a) => a.includes('down'))).toBe(true);
    expect(listAllocations()).toEqual([]);
  });

  it('a failed seed tears down too', async () => {
    const docker = fakeDocker({ seedCode: 2 });
    const res = await previewUp(input(docker));
    expect(res.ok).toBe(false);
    expect(docker.calls.some((a) => a.includes('down'))).toBe(true);
  });

  it('an app that never answers is a failure, not a ready preview', async () => {
    const docker = fakeDocker();
    const yml = `${PREVIEW_YML}\nready: { timeoutSec: 10 }`;
    const res = await previewUp(
      input(docker, {
        readAtRef: async (_r, p) => ({ '.ai/cezar/preview.yml': yml, 'compose.yaml': '' })[p] ?? null,
        fetchImpl: (async () => new Response('', { status: 502 })) as typeof fetch,
        now: () => new Date(),
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/did not answer/);
    expect(docker.calls.some((a) => a.includes('down'))).toBe(true);
  }, 30_000);

  it('says so when docker compose is missing or too old', async () => {
    const missing: DockerExec = async () => ({ code: 127, stdout: '', stderr: 'docker: command not found' });
    const a = await previewUp(input({ exec: missing, calls: [] }));
    expect(a.ok === false && a.error).toMatch(/not available/);
    const old = await previewUp(input(fakeDocker({ version: '2.20.2' })));
    expect(old.ok === false && old.error).toMatch(/too old/);
  });

  it('with no compose anywhere, fails with the hint instead of throwing', async () => {
    const res = await previewUp(input(fakeDocker(), { readAtRef: async () => null }));
    expect(res.ok === false && res.error).toMatch(/no compose file found/);
  });

  it('dry run touches no docker and still reports ports', async () => {
    const calls: string[][] = [];
    const res = await previewUp(input({ exec: async (a) => (calls.push(a), { code: 0, stdout: '', stderr: '' }), calls }, { dryRun: true }));
    expect(res.ok).toBe(true);
    expect(calls).toEqual([]);
    if (res.ok) expect(res.state.ports[0]?.hostPort).toBe(41000);
    expect(existsSync(join(dir, 'data', 'previews'))).toBe(false);
  });
});

describe('helpers', () => {
  it('composeVersionOk', () => {
    expect(composeVersionOk('2.24.0')).toBe(true);
    expect(composeVersionOk('v2.29.1-desktop.1')).toBe(true);
    expect(composeVersionOk('3.0.0')).toBe(true);
    expect(composeVersionOk('2.23.9')).toBe(false);
    expect(composeVersionOk('garbage')).toBe(false);
  });
  it('composeProjectName is a valid, stable compose name', () => {
    expect(composeProjectName('Altflow Metrics!', 'ABCDEF12-3456')).toBe('cez-altflow-metrics-abcdef12');
    expect(composeProjectName('', 'x1')).toBe('cez-project-x1');
  });
});

describe('previewUp — serviceEnv', () => {
  it('tells the app its public host and the other app\'s port', async () => {
    const yml = `${PREVIEW_YML}\nserviceEnv:\n  web: { API_URL: "http://{host}:{port:frontend}/api" }`;
    const res = await previewUp(
      input(fakeDocker(), {
        publicHost: 'devbox.lan',
        readAtRef: async (_r, p) => ({ '.ai/cezar/preview.yml': yml, 'compose.yaml': '' })[p] ?? null,
      }),
    );
    expect(res.ok).toBe(true);
    const override = readFileSync(join(dir, 'data', 'previews', 'abcdef12-0000', 'override.yml'), 'utf8');
    expect(override).toContain('API_URL: "http://devbox.lan:41000/api"');
    if (res.ok) expect(res.state.host).toBe('devbox.lan');
  });
});
