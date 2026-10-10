import { describe, expect, it, vi } from 'vitest';
import {
  trackerAssociationResultSchema,
  trackerCandidatesResultSchema,
  trackerItemResultSchema,
  trackerItemsResultSchema,
  type TrackerAssociation,
} from '@open-mercato/cezar-contract';
import { createYouTrackClient } from './youtrack.ts';

const origin = 'https://acme.youtrack.cloud';
const credentials = { origin, token: 'perm-youtrack-secret-token' };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

// Shapes below mirror live responses from a YouTrack 2026.3 instance.
const project = { id: '22-68', name: 'Project One', shortName: 'PROJ', $type: 'Project' };

function issue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    idReadable: 'PROJ-1',
    summary: 'First issue',
    description: 'Issue **body**',
    created: 1767323045000,
    updated: 1770091506000,
    resolved: null,
    reporter: { fullName: 'Ada Lovelace', login: 'ada', $type: 'User' },
    project: { id: '22-68', $type: 'Project' },
    tags: [{ name: 'backend', $type: 'Tag' }],
    customFields: [
      { value: { name: 'Task', $type: 'EnumBundleElement' }, $type: 'SingleEnumIssueCustomField' },
      { value: [], $type: 'MultiVersionIssueCustomField' },
      { value: { name: 'In Progress', $type: 'StateBundleElement' }, $type: 'StateIssueCustomField' },
    ],
    $type: 'Issue',
    ...overrides,
  };
}

function association(sourceId = 'uuid-1', webUrl = origin): TrackerAssociation {
  return { kind: 'youtrack', source: { id: sourceId, webUrl }, externalId: '22-68', externalName: 'Project One' };
}

/** Routes the three read endpoints; `issues` answers the search and the detail lookup. */
function vendor(handlers: {
  projects?: (url: URL) => Response;
  issues?: (url: URL) => Response;
  uuid?: string;
} = {}) {
  const urls: URL[] = [];
  const headers: Array<Record<string, string>> = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    urls.push(url);
    headers.push(init?.headers as Record<string, string>);
    if (url.origin !== origin) throw new Error(`Unexpected origin: ${url.origin}`);
    if (url.pathname === '/api/config') return json({ uuid: handlers.uuid ?? 'uuid-1', $type: 'FrontendConfig' });
    if (url.pathname === '/api/admin/projects/22-68') return json(project);
    if (url.pathname === '/api/admin/projects' && handlers.projects) return handlers.projects(url);
    if (url.pathname.startsWith('/api/issues') && handlers.issues) return handlers.issues(url);
    throw new Error(`Unexpected URL: ${url}`);
  }) as unknown as typeof fetch;
  return { fetcher, urls, headers, searches: () => urls.filter(url => url.pathname === '/api/issues') };
}

describe('YouTrack Cloud adapter', () => {
  it('discovers the instance identity and sends the permanent token as a bearer credential', async () => {
    const { fetcher, headers } = vendor({ projects: () => json([project]) });
    const result = trackerCandidatesResultSchema.parse(await createYouTrackClient(credentials, fetcher).listCandidates({ kind: 'youtrack', limit: 50 }));
    expect(result).toEqual({
      available: true, source: { id: 'uuid-1', webUrl: origin },
      candidates: [{ id: '22-68', name: 'Project One' }], truncated: false,
    });
    expect(headers.every(header => header.Authorization === 'Bearer perm-youtrack-secret-token')).toBe(true);
  });

  it('pages projects with an extra row, passes the search server-side and binds cursors to the query', async () => {
    const rows = [1, 2, 3].map(n => ({ id: `22-${n}`, name: `Project ${n}`, shortName: `P${n}` }));
    const { fetcher, urls } = vendor({
      projects: url => json(rows.slice(Number(url.searchParams.get('$skip')), Number(url.searchParams.get('$skip')) + Number(url.searchParams.get('$top')))),
    });
    const client = createYouTrackClient(credentials, fetcher);
    const first = trackerCandidatesResultSchema.parse(await client.listCandidates({ kind: 'youtrack', q: 'project', limit: 2 }));
    expect(first).toMatchObject({ available: true, truncated: true, candidates: [{ id: '22-1' }, { id: '22-2' }] });
    if (!first.available) throw new Error('expected a successful page');
    const second = trackerCandidatesResultSchema.parse(await client.listCandidates({ kind: 'youtrack', q: 'project', limit: 2, cursor: first.nextCursor }));
    expect(second).toMatchObject({ available: true, truncated: false, candidates: [{ id: '22-3', name: 'Project 3' }] });
    const requests = urls.filter(url => url.pathname === '/api/admin/projects');
    expect(requests.map(url => [url.searchParams.get('query'), url.searchParams.get('$skip'), url.searchParams.get('$top')]))
      .toEqual([['project', '0', '3'], ['project', '2', '3']]);

    expect(await client.listCandidates({ kind: 'youtrack', q: 'different', limit: 2, cursor: first.nextCursor }))
      .toMatchObject({ available: false, code: 'invalid_cursor' });
  });

  it('resolves only database project IDs and rejects a short name answered under another ID', async () => {
    const { fetcher, urls } = vendor();
    const client = createYouTrackClient(credentials, fetcher);
    expect(trackerAssociationResultSchema.parse(await client.resolveAssociation({ kind: 'youtrack', externalId: 'PROJ', sourceId: 'uuid-1' })))
      .toMatchObject({ available: false, code: 'not_found' });
    expect(urls.map(url => url.pathname)).toEqual(['/api/config']);
    expect(await client.resolveAssociation({ kind: 'youtrack', externalId: '22-68', sourceId: 'other-uuid' }))
      .toMatchObject({ available: false, code: 'source_changed' });
    expect(trackerAssociationResultSchema.parse(await client.resolveAssociation({ kind: 'youtrack', externalId: '22-68', sourceId: 'uuid-1' }))).toEqual({
      available: true,
      association: { kind: 'youtrack', source: { id: 'uuid-1', webUrl: origin }, externalId: '22-68', externalName: 'Project One' },
    });
  });

  it('keeps user text and labels out of the query grammar and looks a bare issue ID up directly', async () => {
    const { fetcher, searches } = vendor({ issues: () => json([]) });
    const driver = createYouTrackClient(credentials, fetcher).driver(association());
    expect((await driver.searchItems({ q: 'crash" sort by: created -fixed or tag: x', limit: 50, state: 'active', labels: ['to be tested', 'backend'] })).available).toBe(true);
    expect((await driver.searchItems({ q: 'PROJ-123', limit: 50, state: 'all' })).available).toBe(true);
    expect((await driver.listIssues({ limit: 50, state: 'all' })).available).toBe(true);
    expect(searches().map(url => url.searchParams.get('query'))).toEqual([
      'project: {PROJ} #Unresolved tag: {to be tested} and tag: {backend} "crash" "sort" "by:" "created" "-fixed" "or" "tag:" "x" sort by: updated desc',
      'project: {PROJ} PROJ-123 sort by: updated desc',
      'project: {PROJ} sort by: updated desc',
    ]);
  });

  it('answers an empty page, not an outage, for a tag the vendor cannot resolve or express', async () => {
    const invalidQuery = () => json({ error: 'invalid_query', error_description: 'Can\'t parse search query' }, 400);
    const { fetcher, searches } = vendor({ issues: invalidQuery });
    const driver = createYouTrackClient(credentials, fetcher).driver(association());
    expect(await driver.listIssues({ limit: 50, state: 'all', labels: ['never-used'] })).toEqual({ available: true, items: [], truncated: false });
    expect(await driver.listIssues({ limit: 50, state: 'all', labels: ['br{ace'] })).toEqual({ available: true, items: [], truncated: false });
    expect(await driver.searchItems({ q: '""', limit: 50, state: 'all' })).toEqual({ available: true, items: [], truncated: false });
    expect(searches()).toHaveLength(1);
    // Without labels nothing user-authored reaches the grammar, so the same answer is a failure.
    expect(await driver.listIssues({ limit: 50, state: 'all' })).toMatchObject({ available: false, code: 'unavailable' });
  });

  it('pages issues by offset and binds the cursor to the complete issue query', async () => {
    const { fetcher, searches } = vendor({
      issues: url => json(url.searchParams.get('$skip') === '0' ? [issue(), issue({ idReadable: 'PROJ-2' })] : [issue({ idReadable: 'PROJ-2' })]),
    });
    const driver = createYouTrackClient(credentials, fetcher).driver(association());
    const first = trackerItemsResultSchema.parse(await driver.listIssues({ limit: 1, state: 'active', labels: ['backend'] }));
    expect(first).toMatchObject({ available: true, truncated: true, items: [{ id: 'PROJ-1' }] });
    if (!first.available) throw new Error('expected a successful page');
    const second = trackerItemsResultSchema.parse(await driver.listIssues({ limit: 1, state: 'active', labels: ['backend'], cursor: first.nextCursor }));
    expect(second).toMatchObject({ available: true, truncated: false, items: [{ id: 'PROJ-2' }] });
    expect(searches().map(url => [url.searchParams.get('$skip'), url.searchParams.get('$top')])).toEqual([['0', '2'], ['1', '2']]);

    expect(await driver.listIssues({ limit: 1, state: 'all', labels: ['backend'], cursor: first.nextCursor }))
      .toMatchObject({ available: false, code: 'invalid_cursor' });
  });

  it('rejects a changed YouTrack source before reading the project', async () => {
    const { fetcher, urls } = vendor({ uuid: 'uuid-2' });
    expect(await createYouTrackClient(credentials, fetcher).driver(association('uuid-1')).listIssues({ limit: 50, state: 'active' }))
      .toMatchObject({ available: false, code: 'source_changed' });
    expect(urls.map(url => url.pathname)).toEqual(['/api/config']);
    expect(await createYouTrackClient(credentials, fetcher).driver(association('uuid-2', 'https://other.youtrack.cloud')).listIssues({ limit: 50, state: 'active' }))
      .toMatchObject({ available: false, code: 'source_changed' });
  });

  it('enforces project scope and validates issue IDs on direct detail lookup', async () => {
    const { fetcher, urls } = vendor({
      issues: url => url.pathname.endsWith('/MISSING-9')
        ? json({ error: 'Not Found', error_description: 'Entity with id MISSING-9 not found' }, 404)
        : json(issue({ idReadable: 'OTHER-2', project: { id: '22-99' } })),
    });
    const driver = createYouTrackClient(credentials, fetcher).driver(association());
    expect(await driver.getItem('../PROJ-1')).toMatchObject({ available: false, code: 'not_found' });
    expect(await driver.getItem('PROJ-0')).toMatchObject({ available: false, code: 'not_found' });
    expect(urls.some(url => url.pathname.startsWith('/api/issues'))).toBe(false);
    expect(trackerItemResultSchema.parse(await driver.getItem('OTHER-2'))).toMatchObject({ available: false, code: 'not_found' });
    expect(trackerItemResultSchema.parse(await driver.getItem('MISSING-9'))).toMatchObject({ available: false, code: 'not_found' });
  });

  it('maps issue fields, timestamps and the state field by type', async () => {
    const { fetcher } = vendor({ issues: () => json(issue()) });
    const result = trackerItemResultSchema.parse(await createYouTrackClient(credentials, fetcher).driver(association()).getItem('PROJ-1'));
    expect(result).toEqual({ available: true, item: {
      kind: 'issue', id: 'PROJ-1', title: 'First issue', author: 'Ada Lovelace',
      createdAt: '2026-01-02T03:04:05.000Z', updatedAt: '2026-02-03T04:05:06.000Z',
      labels: ['backend'], body: 'Issue **body**', bodyTruncated: false, unsupportedContent: false,
      url: `${origin}/issue/PROJ-1`, status: 'In Progress',
    } });
  });

  it('falls back to resolution for a project without a state field and to login for a nameless reporter', async () => {
    const rows = [
      issue({ customFields: [], reporter: { login: 'ada' } }),
      issue({ idReadable: 'PROJ-2', customFields: [{ value: null, $type: 'StateIssueCustomField' }], resolved: 1770091506000, reporter: null, description: null, summary: null }),
    ];
    const { fetcher } = vendor({ issues: () => json(rows) });
    const result = await createYouTrackClient(credentials, fetcher).driver(association()).listIssues({ limit: 50, state: 'all' });
    expect(result.available && result.items.map(row => [row.status, row.author, row.body, row.title])).toEqual([
      ['Open', 'ada', 'Issue **body**', 'First issue'], ['Resolved', 'Unknown', '', ''],
    ]);
  });

  it('caps preview and detail descriptions independently and discloses legacy wiki markup', async () => {
    const long = issue({ description: 'x'.repeat(70_000) });
    const legacy = issue({ idReadable: 'PROJ-2', description: '<div class="wiki text prewrapped">old<br/>markup</div>\n' });
    const { fetcher } = vendor({ issues: url => url.pathname === '/api/issues' ? json([long, legacy]) : json(long) });
    const driver = createYouTrackClient(credentials, fetcher).driver(association());
    const list = await driver.listIssues({ limit: 50, state: 'all' });
    if (!list.available) throw new Error('expected a successful page');
    expect(list.items[0]).toMatchObject({ bodyTruncated: true, unsupportedContent: false });
    expect(list.items[0]?.body).toHaveLength(8_000);
    expect(list.items[1]).toMatchObject({ bodyTruncated: false, unsupportedContent: true });
    const detail = await driver.getItem('PROJ-1');
    expect(detail.available && detail.item.body.length).toBe(60_000);
    expect(detail.available && detail.item.bodyTruncated).toBe(true);
  });

  it('returns controlled failures for malformed data, denied access and throttling without leaking the token', async () => {
    const malformed = vendor({ issues: () => json([issue({ created: 'yesterday' })]), projects: () => json({ unexpected: true }) });
    const client = createYouTrackClient(credentials, malformed.fetcher);
    expect(await client.driver(association()).listIssues({ limit: 50, state: 'all' })).toMatchObject({ available: false, code: 'invalid_response' });
    expect(await client.listCandidates({ kind: 'youtrack', limit: 50 })).toMatchObject({ available: false, code: 'invalid_response' });

    const denied = createYouTrackClient(credentials, (async () => json({ error: 'Unauthorized', error_description: 'Invalid token' }, 401)) as unknown as typeof fetch);
    const unauthorized = await denied.listCandidates({ kind: 'youtrack', limit: 50 });
    expect(unauthorized).toMatchObject({ available: false, code: 'unauthorized' });
    expect(JSON.stringify(unauthorized)).not.toContain('perm-youtrack-secret-token');
    expect(JSON.stringify(unauthorized)).not.toContain('Invalid token');

    let calls = 0;
    const throttled = createYouTrackClient(credentials, (async (input: string | URL | Request) => {
      if (new URL(String(input)).pathname === '/api/config') return json({ uuid: 'uuid-1' });
      calls++;
      return json({}, 429, { 'retry-after': '30' });
    }) as unknown as typeof fetch);
    expect(await throttled.listCandidates({ kind: 'youtrack', limit: 50 })).toMatchObject({ available: false, code: 'rate_limited', retryAfterSeconds: 30 });
    expect(await throttled.listCandidates({ kind: 'youtrack', q: 'again', limit: 50 })).toMatchObject({ available: false, code: 'rate_limited' });
    expect(calls).toBe(1);
  });

  it('maps a vanished project to unavailable on lists and not_found on association', async () => {
    const gone = (async (input: string | URL | Request) => new URL(String(input)).pathname === '/api/config'
      ? json({ uuid: 'uuid-1' }) : json({ error: 'Not Found' }, 404)) as unknown as typeof fetch;
    const client = createYouTrackClient(credentials, gone);
    expect(await client.driver(association()).listIssues({ limit: 50, state: 'all' })).toMatchObject({ available: false, code: 'unavailable' });
    expect(await client.resolveAssociation({ kind: 'youtrack', externalId: '22-68', sourceId: 'uuid-1' })).toMatchObject({ available: false, code: 'not_found' });
  });

  it('caches a list page, replaces it on refresh and revalidates every detail read', async () => {
    let version = 0;
    const { fetcher, urls } = vendor({ issues: () => json(issue({ summary: `Version ${++version}` })) });
    const wrapped = vendor({ issues: () => json([issue({ summary: `Version ${++version}` })]) });
    const list = createYouTrackClient(credentials, wrapped.fetcher).driver(association());
    const titles = async (refresh?: '1') => {
      const result = await list.listIssues({ limit: 50, state: 'all', ...(refresh ? { refresh } : {}) });
      return result.available ? result.items[0]?.title : result.code;
    };
    expect([await titles(), await titles(), await titles('1'), await titles()]).toEqual(['Version 1', 'Version 1', 'Version 2', 'Version 2']);

    version = 0;
    const driver = createYouTrackClient(credentials, fetcher).driver(association());
    const first = await driver.getItem('PROJ-1');
    const second = await driver.getItem('PROJ-1');
    expect([first.available && first.item.title, second.available && second.item.title]).toEqual(['Version 1', 'Version 2']);
    expect(urls.filter(url => url.pathname === '/api/config')).toHaveLength(1);
  });

  it('forgets the cached source identity when the cache is cleared', async () => {
    const { fetcher, urls } = vendor({ projects: () => json([project]) });
    const client = createYouTrackClient(credentials, fetcher);
    await client.listCandidates({ kind: 'youtrack', limit: 50 });
    client.clearCache();
    await client.listCandidates({ kind: 'youtrack', limit: 50 });
    expect(urls.filter(url => url.pathname === '/api/config')).toHaveLength(2);
    expect(urls.filter(url => url.pathname === '/api/admin/projects')).toHaveLength(2);
  });
});
