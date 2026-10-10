import { join } from 'node:path';
import type { TrackerAssociation } from '@open-mercato/cezar-contract';
import { readTrackerAssociation } from '../../tracker-association.ts';
import { credentialEnv } from './connection-env.ts';
import { TrackerConnections } from './connections.ts';

export class TrackerAgentBindingError extends Error {
  constructor() { super('Tracker connection or scope changed. Create a new run from the current automation.'); }
}

/** Resolve only the credential revision captured by the run, never its replacement. */
export async function resolveTrackerAgentEnv(
  root: string,
  expected: TrackerAssociation | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, string>> {
  if (!expected || env.CEZ_DRY_RUN === '1') return {};
  const current = await readTrackerAssociation(join(root, '.ai/cezar'));
  const record = await new TrackerConnections(env).read(root);
  if (!expected.connectionId || !current || !record
    || current.kind !== expected.kind || current.externalId !== expected.externalId
    || current.source.id !== expected.source.id || current.source.webUrl !== expected.source.webUrl
    || current.connectionId !== expected.connectionId || record.id !== expected.connectionId
    || record.credentials.kind !== expected.kind) throw new TrackerAgentBindingError();
  return credentialEnv(record.credentials);
}
