import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { writeTrackerAssociation } from '../tracker-association.ts';
import type { RunManager, StartRunInput } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';

/**
 * `POST /api/v1/runs` `trackerItem` (spec 2026-10-15-ticket-implement-review-workflow §13): the
 * YouTrack ticket a task was launched from. The id lands in a branch name, commit messages and a
 * PR title, so the route accepts only a strictly shaped id on the project's own YouTrack source.
 */
describe('POST /api/v1/runs trackerItem', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let app: Hono;
  let captured: StartRunInput | undefined;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-startrun-ticket-'));
    dataDir = join(repoRoot, '.ai/cezar');
    store = RunStore.open(dataDir);
    captured = undefined;
    const manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) => {
        captured = input;
        return store.createRun({ title: 't', workflow: '(planned)', task: input.task, steps: [] });
      },
    } as unknown as RunManager;
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test', providerAuth: connectedProviderAuth() });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const post = (body: unknown) =>
    apiRequest(app, '/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const base = { task: 'do the thing', steps: [{ id: 'work', prompt: '{{task}}' }] };
  const ticket = { kind: 'youtrack', id: 'TERM-396', url: 'https://altflow.youtrack.cloud/issue/TERM-396', title: 'Fix the export' };
  const associate = (kind: 'youtrack' | 'jira', webUrl = 'https://altflow.youtrack.cloud') =>
    writeTrackerAssociation(dataDir, { kind, source: { id: 'src', webUrl }, externalId: '0-1', externalName: 'AltFlowMetrics' });

  it('passes a ticket on the associated YouTrack source through to the manager', async () => {
    await associate('youtrack');
    const res = await post({ ...base, trackerItem: ticket });
    expect(res.status).toBe(201);
    expect(captured?.trackerItem).toEqual(ticket);
  });

  it('leaves a task without a ticket exactly as before: no trackerItem key at all', async () => {
    const res = await post(base);
    expect(res.status).toBe(201);
    expect(captured && 'trackerItem' in captured).toBe(false);
  });

  it('rejects a ticket when the project has no YouTrack association', async () => {
    expect((await post({ ...base, trackerItem: ticket })).status).toBe(400);
    await associate('jira', 'https://altflow.atlassian.net');
    expect((await post({ ...base, trackerItem: ticket })).status).toBe(400);
    expect(captured).toBeUndefined();
  });

  it('rejects a ticket on another YouTrack instance', async () => {
    await associate('youtrack', 'https://other.youtrack.cloud');
    const res = await post({ ...base, trackerItem: ticket });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/not on the associated youtrack instance/);
  });

  it.each(['--upload-pack=x', 'TERM-396/../main', 'term-396', 'TERM-0', 'TERM 396', 'TERM-396;rm', ''])(
    'rejects the unsafe ticket id %j before anything else runs',
    async (id) => {
      await associate('youtrack');
      expect((await post({ ...base, trackerItem: { ...ticket, id } })).status).toBe(400);
      expect(captured).toBeUndefined();
    },
  );

  it('rejects unknown keys and non-https urls on the ticket', async () => {
    await associate('youtrack');
    expect((await post({ ...base, trackerItem: { ...ticket, extra: 1 } })).status).toBe(400);
    expect((await post({ ...base, trackerItem: { ...ticket, url: 'http://altflow.youtrack.cloud/issue/TERM-396' } })).status).toBe(400);
  });
});
