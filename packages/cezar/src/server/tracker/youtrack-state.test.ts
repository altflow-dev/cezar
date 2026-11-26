import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { writeTrackerAssociation } from '../../tracker-association.ts';
import { TrackerConnections } from './connections.ts';
import { createYouTrackStateClient } from './youtrack-state.ts';

/** Spec 2026-11-26-workflow-tracker-state: the project's own connection, its own host only. */
let root: string;
let project: string;
let env: NodeJS.ProcessEnv;
const calls: { url: string; init: RequestInit }[] = [];
const issue = { id: 'SPM-405', url: 'https://acme.youtrack.cloud/issue/SPM-405' };

const fetcher = (responses: { status: number; body: unknown }[]): typeof fetch =>
  (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const next = responses.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;

beforeEach(async () => {
  calls.length = 0;
  root = await mkdtemp(join(tmpdir(), 'tracker-state-'));
  project = join(root, 'project');
  await mkdir(project);
  env = { CEZ_HOME: join(root, 'home') };
  const record = await new TrackerConnections(env).write(project, { kind: 'youtrack', origin: 'https://acme.youtrack.cloud', token: 'synthetic-token' });
  await writeTrackerAssociation(join(project, '.ai/cezar'), {
    kind: 'youtrack',
    source: { id: 'src', webUrl: 'https://acme.youtrack.cloud' },
    externalId: '0-23',
    externalName: 'SPMarketing',
    connectionId: record!.id,
  });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('reads the State value name from the issue', async () => {
  const client = createYouTrackStateClient(fetcher([{ status: 200, body: { customFields: [{ name: 'Priority', value: { name: 'Normal' } }, { name: 'State', value: { name: 'Submitted' } }] } }]), env);
  expect(await client.get(project, issue)).toEqual({ ok: true, value: 'Submitted' });
  expect(calls[0]!.url).toBe('https://acme.youtrack.cloud/api/issues/SPM-405?fields=customFields(name,value(name))');
  expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer synthetic-token');
});

it('sets the state with a braced command, so a two-word value stays one token', async () => {
  const client = createYouTrackStateClient(fetcher([{ status: 200, body: {} }]), env);
  expect(await client.set(project, issue, 'In Progress')).toEqual({ ok: true, value: true });
  expect(calls[0]!.url).toBe('https://acme.youtrack.cloud/api/commands');
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ query: 'State {In Progress}', issues: [{ idReadable: 'SPM-405' }] });
});

it('never sends the token to a ticket on another host', async () => {
  const client = createYouTrackStateClient(fetcher([]), env);
  const foreign = { id: 'SPM-405', url: 'https://evil.example/issue/SPM-405' };
  const res = await client.set(project, foreign, 'In Progress');
  expect(res.ok).toBe(false);
  expect(calls).toHaveLength(0);
});

it('reports an HTTP refusal with YouTrack\'s own reason, without throwing', async () => {
  const client = createYouTrackStateClient(fetcher([{ status: 403, body: { error: 'Forbidden', error_description: 'No permission' } }]), env);
  expect(await client.set(project, issue, 'In Progress')).toEqual({ ok: false, reason: 'YouTrack answered HTTP 403 (No permission)' });
});

it('refuses without a request when the project has no YouTrack connection', async () => {
  await new TrackerConnections(env).remove(project);
  const client = createYouTrackStateClient(fetcher([]), env);
  expect((await client.get(project, issue)).ok).toBe(false);
  expect(calls).toHaveLength(0);
});
