/**
 * Read and set a YouTrack issue's `State`, for the `tracker.set-state` workflow node and the
 * restore on cancel (spec `.ai/specs/2026-11-26-workflow-tracker-state.md`).
 *
 * It uses the project's own tracker connection (the YouTrack tab's), resolved per call through
 * `resolveTrackerAgentEnv`, so it needs no new secret. The token goes only to that connection's
 * origin: a ticket URL on another host is refused before any request. Never throws; every
 * failure is a `{ ok: false, reason }` the caller turns into a note.
 */
import { join } from 'node:path';
import { readTrackerAssociation } from '../../tracker-association.ts';
import { resolveTrackerAgentEnv } from './agent-credentials.ts';

export type TrackerStateResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface TrackerStateClient {
  /** The issue's current State value name (API name, e.g. `In Progress`); `''` when it has none. */
  get(root: string, issue: { id: string; url: string }): Promise<TrackerStateResult<string>>;
  /** Set the issue's State field to the value with this API name (e.g. `In Progress`). */
  set(root: string, issue: { id: string; url: string }, state: string): Promise<TrackerStateResult<true>>;
}

const TIMEOUT_MS = 15_000;
const ISSUE_ID = /^[\p{L}\p{N}_]+-[1-9]\d*$/u;

interface Target { origin: string; token: string }

async function target(root: string, issue: { id: string; url: string }, env: NodeJS.ProcessEnv): Promise<TrackerStateResult<Target>> {
  if (!ISSUE_ID.test(issue.id)) return { ok: false, reason: `"${issue.id}" is not a YouTrack issue id` };
  let creds: Record<string, string>;
  try {
    const association = await readTrackerAssociation(join(root, '.ai/cezar'));
    if (!association || association.kind !== 'youtrack') return { ok: false, reason: 'this project has no YouTrack connection' };
    creds = await resolveTrackerAgentEnv(root, association, env);
  } catch {
    return { ok: false, reason: "the project's YouTrack connection could not be read" };
  }
  const base = creds.YOUTRACK_BASE_URL;
  const token = creds.YOUTRACK_TOKEN;
  if (!base || !token) return { ok: false, reason: "the project's YouTrack connection has no token" };
  let origin: string;
  let issueOrigin: string;
  try {
    origin = new URL(base).origin;
    issueOrigin = new URL(issue.url).origin;
  } catch {
    return { ok: false, reason: 'the ticket or connection URL is not valid' };
  }
  if (origin !== issueOrigin) {
    return { ok: false, reason: `the ticket is on ${issueOrigin}, the project's connection on ${origin}` };
  }
  return { ok: true, value: { origin, token } };
}

async function call(fetcher: typeof fetch, url: string, token: string, init: RequestInit = {}): Promise<TrackerStateResult<unknown>> {
  try {
    const res = await fetcher(url, {
      ...init,
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = '';
      try {
        const body = JSON.parse(text) as { error_description?: string; error?: string };
        detail = body.error_description || body.error || '';
      } catch {
        // not JSON: the status alone says enough
      }
      return { ok: false, reason: `YouTrack answered HTTP ${res.status}${detail ? ` (${detail})` : ''}` };
    }
    return { ok: true, value: text ? JSON.parse(text) : null };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return { ok: false, reason: timedOut ? 'YouTrack did not answer in time' : 'YouTrack could not be reached' };
  }
}

interface StateField { name: string; type: string; value: string }

/** The issue's `State` field: its API name, its issue-field `$type` (needed to write it) and value. */
async function readStateField(fetcher: typeof fetch, t: Target, id: string): Promise<TrackerStateResult<StateField>> {
  const res = await call(fetcher, `${t.origin}/api/issues/${encodeURIComponent(id)}?fields=customFields(name,$type,value(name))`, t.token);
  if (!res.ok) return res;
  const fields = (res.value as { customFields?: { name?: string; $type?: string; value?: { name?: string } | null }[] } | null)?.customFields;
  if (!Array.isArray(fields)) return { ok: false, reason: 'YouTrack returned no custom fields for the issue' };
  const field = fields.find((f) => f.name === 'State');
  if (!field) return { ok: false, reason: 'the issue has no State field' };
  return { ok: true, value: { name: 'State', type: field.$type ?? 'StateIssueCustomField', value: field.value?.name ?? '' } };
}

export function createYouTrackStateClient(fetcher: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env): TrackerStateClient {
  return {
    async get(root, issue) {
      const t = await target(root, issue, env);
      if (!t.ok) return t;
      const field = await readStateField(fetcher, t.value, issue.id);
      return field.ok ? { ok: true, value: field.value.value } : field;
    },
    async set(root, issue, state) {
      const t = await target(root, issue, env);
      if (!t.ok) return t;
      const wanted = state.trim();
      if (!wanted) return { ok: false, reason: 'no State value to set' };
      // The field itself, by API names — not a command. YouTrack parses commands in the
      // instance's language (`Status`/`W realizacji` on a Polish one), so `State {In Progress}`
      // was rejected there; the REST field update takes the API names on every instance.
      const field = await readStateField(fetcher, t.value, issue.id);
      if (!field.ok) return field;
      const res = await call(fetcher, `${t.value.origin}/api/issues/${encodeURIComponent(issue.id)}?fields=id`, t.value.token, {
        method: 'POST',
        body: JSON.stringify({ customFields: [{ name: field.value.name, $type: field.value.type, value: { name: wanted } }] }),
      });
      return res.ok ? { ok: true, value: true } : res;
    },
  };
}
