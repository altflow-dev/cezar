import { z } from 'zod';
import type {
  TrackerAssociation,
  TrackerAssociationInput,
  TrackerAssociationResult,
  TrackerCandidatesQuery,
  TrackerCandidatesResult,
  TrackerItem,
  TrackerItemResult,
  TrackerItemsResult,
  TrackerListQuery,
  TrackerSearchQuery,
  TrackerSource,
  TrackerStateOption,
  TrackerStatesResponse,
} from '@open-mercato/cezar-contract';
import { descriptionBody } from './adf.ts';
import { decodeCursor, encodeCursor } from './cursor.ts';
import {
  ResultCache,
  TrackerHttp,
  TrackerRequestError,
  requestFailure,
  runOperation,
} from './transport.ts';
import type { TrackerProvider, TrackerDriver } from './types.ts';

// YouTrack database IDs (`22-68`); the short name (`KT`) can be renamed, so it is never persisted.
const projectIdPattern = /^\d+-\d+$/;
const issueIdPattern = /^[\p{L}\p{N}_]+-[1-9]\d*$/u;

const configSchema = z.object({ uuid: z.string().min(1) });
const projectSchema = z.object({
  id: z.string().regex(projectIdPattern),
  name: z.string().min(1),
  shortName: z.string().min(1),
});
const issueSchema = z.object({
  idReadable: z.string().regex(issueIdPattern),
  summary: z.string().nullable(),
  description: z.string().nullable(),
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  resolved: z.number().nullable(),
  reporter: z.object({ fullName: z.string().nullish(), login: z.string().nullish() }).nullable(),
  project: z.object({ id: z.string().regex(projectIdPattern) }),
  tags: z.array(z.object({ name: z.string() })),
  customFields: z.array(z.object({ $type: z.string(), value: z.unknown() })),
});
const errorSchema = z.object({ error: z.string() });
const stateValueSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  localizedName: z.string().nullish(),
  isResolved: z.boolean().nullish(),
  archived: z.boolean().nullish(),
  ordinal: z.number().nullish(),
});
const projectFieldSchema = z.object({
  $type: z.string(),
  field: z.object({ name: z.string().min(1) }).nullish(),
  bundle: z.object({ values: z.array(stateValueSchema).nullish() }).nullish(),
});

type YouTrackIssue = z.infer<typeof issueSchema>;
/** The project's state field: its (freely chosen) name, which a search clause must use, and values. */
type StateField = { available: true; fieldName: string; states: TrackerStateOption[] };
type CachedResult = TrackerCandidatesResult | TrackerAssociationResult | TrackerItemsResult | TrackerItemResult | StateField;

const projectFields = 'id,name,shortName';
const issueFields = 'idReadable,summary,description,created,updated,resolved,reporter(fullName,login),project(id),tags(name),customFields(value(name,localizedName))';
const stateFieldFields = '$type,field(name),bundle(values(id,name,localizedName,isResolved,archived,ordinal))';

/** The vendor could not parse the search query (HTTP 400 `invalid_query`). */
class InvalidQueryError extends Error {}

function invalidResponse(reason = 'YouTrack returned an invalid response. Try again later.'): never {
  throw new TrackerRequestError('invalid_response', reason);
}

function parseVendor<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return invalidResponse();
  return parsed.data;
}

function collectionFailure(error: unknown): Extract<TrackerCandidatesResult | TrackerItemsResult, { available: false }> {
  const failure = requestFailure(error);
  if (failure.code === 'not_found') {
    return { available: false, code: 'unavailable', reason: 'YouTrack could not serve this collection. Try again later.' };
  }
  return failure;
}

function lookupFailure(error: unknown): Extract<TrackerAssociationResult | TrackerItemResult, { available: false }> {
  const failure = requestFailure(error);
  if (failure.code === 'invalid_cursor') {
    return { available: false, code: 'invalid_response', reason: 'YouTrack returned an invalid response. Try again later.' };
  }
  return failure;
}

function timestamp(milliseconds: number): string {
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) return invalidResponse('YouTrack returned an invalid issue timestamp.');
  return date.toISOString();
}

function mapIssue(raw: YouTrackIssue, origin: string, expectedProjectId: string, maximum: number): TrackerItem {
  if (raw.project.id !== expectedProjectId) {
    throw new TrackerRequestError('not_found', 'The requested YouTrack issue was not found in this project.');
  }
  // A project names its state field freely; the field TYPE is what identifies it.
  const state = raw.customFields.find(field => field.$type === 'StateIssueCustomField')?.value;
  const stateName = state && typeof state === 'object' && 'name' in state && typeof state.name === 'string' ? state.name : '';
  // The localized name is what YouTrack shows its users (and what the state filter shows).
  const localized = state && typeof state === 'object' && 'localizedName' in state && typeof state.localizedName === 'string' ? state.localizedName : '';
  const description = raw.description ?? '';
  // Issues written before the Markdown editor still return rendered legacy-wiki HTML.
  const legacyWiki = /^\s*<div class="wiki /.test(description);
  return {
    kind: 'issue',
    id: raw.idReadable,
    title: raw.summary ?? '',
    author: raw.reporter?.fullName || raw.reporter?.login || 'Unknown',
    createdAt: timestamp(raw.created),
    updatedAt: timestamp(raw.updated),
    labels: raw.tags.map(tag => tag.name),
    ...descriptionBody(description, maximum, legacyWiki),
    url: `${origin}/issue/${encodeURIComponent(raw.idReadable)}`,
    status: localized || stateName || (raw.resolved === null ? 'Open' : 'Resolved'),
  };
}

/**
 * YouTrack search has no escape syntax and no grouping, so user text never reaches the query
 * raw: every word becomes its own quoted phrase (implicitly AND-ed), which keeps `sort by:`,
 * `-word`, `or` and `tag:` typed by a user plain text. A bare issue ID stays unquoted because
 * that is the form YouTrack resolves to the issue itself, not only to mentions of it.
 * Returns null when the query cannot match anything (an inexpressible tag, no searchable text).
 */
function searchQuery(shortName: string, query: TrackerListQuery | TrackerSearchQuery, stateField?: StateField): string | null {
  const clauses = [`project: {${shortName}}`];
  if (query.statuses?.length) {
    // Only names the project's state bundle holds reach the query: a verified value can never
    // carry query syntax, and a state the project no longer has matches nothing.
    const known = new Set(stateField?.states.map(state => state.name));
    const wanted = query.statuses.filter(name => known.has(name));
    if (!stateField || !wanted.length) return null;
    // A comma between values means OR; the field name is braced only when it needs to be.
    const field = /\s/.test(stateField.fieldName) ? `{${stateField.fieldName}}` : stateField.fieldName;
    clauses.push(`${field}: ${wanted.map(name => `{${name}}`).join(', ')}`);
  } else if (query.state === 'active') clauses.push('#Unresolved');
  const labels = query.labels ?? [];
  if (labels.some(label => /[{}]/.test(label))) return null;
  // Repeating an attribute means OR in YouTrack; the explicit operator keeps labels AND-ed.
  if (labels.length) clauses.push(labels.map(label => `tag: {${label}}`).join(' and '));
  if ('q' in query) {
    if (issueIdPattern.test(query.q)) clauses.push(query.q);
    else {
      const words = query.q.split(/\s+/).map(word => word.replace(/["\\]/g, '')).filter(Boolean);
      if (!words.length) return null;
      clauses.push(...words.map(word => `"${word}"`));
    }
  }
  return `${clauses.join(' ')} sort by: updated desc`;
}

function sourceChanged(): TrackerRequestError {
  return new TrackerRequestError(
    'source_changed',
    'The saved YouTrack site no longer matches the configured credentials. Reconnect the project.',
  );
}

function offsetFrom(position: string | undefined): number {
  if (position === undefined) return 0;
  const offset = /^(0|[1-9]\d*)$/.test(position) ? Number(position) : NaN;
  if (!Number.isSafeInteger(offset)) {
    throw new TrackerRequestError('invalid_cursor', 'This YouTrack page expired. Start the search again.');
  }
  return offset;
}

export function createYouTrackClient(
  config: { origin: string; token: string },
  fetcher: typeof fetch = fetch,
): TrackerProvider {
  const http = new TrackerHttp(fetcher);
  const cache = new ResultCache<CachedResult>(200, 60_000);
  let sourceValue: TrackerSource | undefined;
  let sourcePending: Promise<TrackerSource> | undefined;
  let generation = 0;

  const get = async (path: string, params: Record<string, string>, signal: AbortSignal): Promise<unknown> => {
    let status = 200;
    const raw = await http.json(`${config.origin}/api${path}?${new URLSearchParams(params)}`, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${config.token}` },
    }, signal, (_headers, responseStatus) => { status = responseStatus; return undefined; });
    if (status === 400) {
      const failure = errorSchema.safeParse(raw);
      if (failure.success && failure.data.error === 'invalid_query') throw new InvalidQueryError();
      throw new TrackerRequestError('unavailable', 'YouTrack rejected the request. Check the query and try again.');
    }
    return raw;
  };

  const source = async (signal: AbortSignal): Promise<TrackerSource> => {
    if (sourceValue) return sourceValue;
    if (sourcePending) return sourcePending;
    const currentGeneration = generation;
    const pending = get('/config', { fields: 'uuid' }, signal).then(value => {
      const resolved = { id: parseVendor(configSchema, value).uuid, webUrl: config.origin };
      if (generation === currentGeneration) sourceValue = resolved;
      return resolved;
    }).finally(() => {
      if (sourcePending === pending) sourcePending = undefined;
    });
    sourcePending = pending;
    return pending;
  };

  const withSource = async <T extends CachedResult>(
    signal: AbortSignal,
    operation: string,
    scope: unknown,
    refresh: boolean,
    read: (currentSource: TrackerSource) => Promise<T>,
  ): Promise<T> => {
    const currentSource = await source(signal);
    const key = JSON.stringify(['youtrack', currentSource.id, currentSource.webUrl, operation, scope]);
    return cache.get(key, () => read(currentSource), refresh) as Promise<T>;
  };

  const ensureAssociationSource = (association: TrackerAssociation, currentSource: TrackerSource): void => {
    if (association.kind !== 'youtrack'
      || association.source.id !== currentSource.id
      || association.source.webUrl !== currentSource.webUrl
      || !projectIdPattern.test(association.externalId)) {
      throw sourceChanged();
    }
  };

  const readProject = async (id: string, signal: AbortSignal) => {
    const project = parseVendor(projectSchema, await get(`/admin/projects/${encodeURIComponent(id)}`, { fields: projectFields }, signal));
    // The endpoint also resolves short names; only the database ID is an accepted identity.
    if (project.id !== id) return invalidResponse();
    return project;
  };

  /** `$top` has no has-more flag, so one extra row is requested and dropped. */
  const page = <T>(rows: T[], limit: number, offset: number, cursorScope: unknown) => {
    const truncated = rows.length > limit;
    return {
      rows: rows.slice(0, limit),
      truncated,
      ...(truncated ? { nextCursor: encodeCursor(cursorScope, String(offset + limit)) } : {}),
    };
  };

  const listCandidates = async (query: TrackerCandidatesQuery): Promise<TrackerCandidatesResult> => {
    try {
      return await runOperation(signal => withSource(
        signal,
        'candidates',
        { q: query.q ?? '', cursor: query.cursor ?? '', limit: query.limit },
        false,
        async currentSource => {
          if (query.kind !== 'youtrack') throw sourceChanged();
          const cursorScope = {
            kind: 'youtrack', source: currentSource, operation: 'candidates', q: query.q ?? '', limit: query.limit,
          };
          const offset = offsetFrom(decodeCursor(cursorScope, query.cursor));
          const raw = await get('/admin/projects', {
            fields: projectFields,
            $skip: String(offset),
            $top: String(query.limit + 1),
            ...(query.q === undefined ? {} : { query: query.q }),
          }, signal);
          const { rows, ...pagination } = page(parseVendor(z.array(projectSchema), raw), query.limit, offset, cursorScope);
          return {
            available: true,
            source: currentSource,
            candidates: rows.map(project => ({ id: project.id, name: project.name })),
            ...pagination,
          };
        },
      ));
    } catch (error) {
      return collectionFailure(error);
    }
  };

  const resolveAssociation = async (input: TrackerAssociationInput): Promise<TrackerAssociationResult> => {
    try {
      return await runOperation(signal => withSource(
        signal,
        'association',
        { kind: input.kind, externalId: input.externalId, sourceId: input.sourceId },
        false,
        async currentSource => {
          if (input.kind !== 'youtrack' || input.sourceId !== currentSource.id) throw sourceChanged();
          if (!projectIdPattern.test(input.externalId)) {
            throw new TrackerRequestError('not_found', 'The selected YouTrack project was not found.');
          }
          const project = await readProject(input.externalId, signal);
          return {
            available: true,
            association: {
              kind: 'youtrack',
              source: currentSource,
              externalId: project.id,
              externalName: project.name,
            },
          };
        },
      ));
    } catch (error) {
      return lookupFailure(error);
    }
  };

  const driver = (association: TrackerAssociation): TrackerDriver => {
    /** The project's state field and its non-archived values, in the project's own order. */
    const readStateField = (signal: AbortSignal, refresh: boolean): Promise<StateField> => withSource(
      signal,
      'state-field',
      { association },
      refresh,
      async currentSource => {
        ensureAssociationSource(association, currentSource);
        const raw = await get(`/admin/projects/${encodeURIComponent(association.externalId)}/customFields`, {
          fields: stateFieldFields, $top: '200',
        }, signal);
        const fields = parseVendor(z.array(projectFieldSchema), raw);
        const field = fields.find(row => row.$type === 'StateProjectCustomField');
        if (!field?.field) return { available: true, fieldName: '', states: [] };
        // A brace would end the clause early; such a field cannot be expressed in a query.
        if (/[{}]/.test(field.field.name)) return { available: true, fieldName: '', states: [] };
        const values = (field.bundle?.values ?? [])
          .filter(value => !value.archived && !/[{}]/.test(value.name))
          .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
        const states = [...new Map(values.map(value => [value.name, {
          id: value.id, name: value.name, label: value.localizedName || value.name, resolved: value.isResolved === true,
        }])).values()];
        return { available: true, fieldName: states.length ? field.field.name : '', states };
      },
    );

    const listStates = async (): Promise<TrackerStatesResponse> => {
      try {
        const field = await runOperation(signal => readStateField(signal, false));
        return { available: true, states: field.states };
      } catch (error) {
        const failure = collectionFailure(error);
        return failure.code === 'invalid_cursor'
          ? { available: false, code: 'invalid_response', reason: failure.reason } : failure;
      }
    };

    const readItems = async (query: TrackerListQuery | TrackerSearchQuery): Promise<TrackerItemsResult> => {
      try {
        const { refresh: _refresh, ...cacheQuery } = query;
        return await runOperation(signal => withSource(
          signal,
          'issues',
          { association, query: cacheQuery },
          query.refresh === '1',
          async currentSource => {
            ensureAssociationSource(association, currentSource);
            const cursorScope = {
              kind: 'youtrack', source: currentSource, operation: 'issues', externalId: association.externalId,
              state: query.state, labels: query.labels ?? [], statuses: query.statuses ?? [],
              ...('q' in query ? { q: query.q } : {}), limit: query.limit,
            };
            const offset = offsetFrom(decodeCursor(cursorScope, query.cursor));
            const project = await readProject(association.externalId, signal);
            if (/[{}]/.test(project.shortName)) return invalidResponse();
            const stateField = query.statuses?.length ? await readStateField(signal, query.refresh === '1') : undefined;
            const search = searchQuery(project.shortName, query, stateField);
            if (search === null) return { available: true, items: [], truncated: false };
            let raw: unknown;
            try {
              raw = await get('/issues', {
                query: search, fields: issueFields, $skip: String(offset), $top: String(query.limit + 1),
              }, signal);
            } catch (error) {
              // Every other part of the query is built here from verified values, so with labels
              // present an unparsable query means a tag this account cannot see: no matches.
              if (error instanceof InvalidQueryError && query.labels?.length) return { available: true, items: [], truncated: false };
              throw error;
            }
            const { rows, ...pagination } = page(parseVendor(z.array(issueSchema), raw), query.limit, offset, cursorScope);
            return {
              available: true,
              items: rows.map(value => mapIssue(value, config.origin, association.externalId, 8_000)),
              ...pagination,
            };
          },
        ));
      } catch (error) {
        if (error instanceof InvalidQueryError) {
          return { available: false, code: 'unavailable', reason: 'YouTrack rejected the request. Check the query and try again.' };
        }
        return collectionFailure(error);
      }
    };

    const getItem = async (id: string): Promise<TrackerItemResult> => {
      try {
        if (!issueIdPattern.test(id) || id.length > 256) {
          throw new TrackerRequestError('not_found', 'The requested YouTrack issue was not found in this project.');
        }
        return await runOperation(signal => withSource(
          signal,
          'issue',
          { association, id },
          // Browser detail cache owns freshness; a new request must revalidate the vendor.
          true,
          async currentSource => {
            ensureAssociationSource(association, currentSource);
            const raw = await get(`/issues/${encodeURIComponent(id)}`, { fields: issueFields }, signal);
            // YouTrack resolves a moved issue's old ID. The project ID checked in mapIssue is
            // authoritative; the canonical current ID is what comes back.
            return {
              available: true,
              item: mapIssue(parseVendor(issueSchema, raw), config.origin, association.externalId, 60_000),
            };
          },
        ));
      } catch (error) {
        return lookupFailure(error);
      }
    };

    return { association, listIssues: readItems, searchItems: readItems, getItem, listStates };
  };

  return {
    kind: 'youtrack',
    listCandidates,
    resolveAssociation,
    driver,
    clearCache() {
      generation++;
      sourceValue = undefined;
      sourcePending = undefined;
      cache.clear();
    },
  };
}
