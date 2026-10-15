import { createHash } from 'node:crypto';
import { parse } from 'dotenv';
import { z } from 'zod';
import { trackerCredentialsSchema, type TrackerCredentials } from '@open-mercato/cezar-contract';

export const connectionRecordSchema = z.object({ id: z.uuid(), projectRoot: z.string().min(1), credentials: trackerCredentialsSchema }).strict();
export type StoredTrackerConnection = z.infer<typeof connectionRecordSchema>;

/** The provider's own keys in the managed file, and the names an agent run receives them under. */
export function credentialEnv(credentials: TrackerCredentials): Record<string, string> {
  switch (credentials.kind) {
    case 'jira': return { JIRA_BASE_URL: credentials.origin, JIRA_EMAIL: credentials.email, JIRA_API_TOKEN: credentials.token };
    case 'linear': return { LINEAR_API_KEY: credentials.key };
    case 'youtrack': return { YOUTRACK_BASE_URL: credentials.origin, YOUTRACK_TOKEN: credentials.token };
  }
}

/**
 * Which of `credentialEnv`'s keys carry a secret, per provider. Keyed by `kind` so a new tracker
 * fails to compile until it names its own — YouTrack shipped without redaction because this list
 * used to be spelled out by hand at the agent-env call site.
 */
const SECRET_ENV_KEYS: { readonly [K in TrackerCredentials['kind']]: readonly string[] } = {
  jira: ['JIRA_API_TOKEN'],
  linear: ['LINEAR_API_KEY'],
  youtrack: ['YOUTRACK_TOKEN'],
};

/** Every value in a tracker agent env that must be redacted from transcripts, including derived encodings. */
export function credentialEnvSecrets(env: Readonly<Record<string, string>>): string[] {
  const secrets = Object.values(SECRET_ENV_KEYS).flat().map(key => env[key]).filter((value): value is string => Boolean(value));
  // Jira authenticates with Basic email:token, so an agent that echoes its own header leaks the encoding.
  if (env.JIRA_EMAIL && env.JIRA_API_TOKEN) secrets.push(Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString('base64'));
  return secrets;
}

const digest = (record: StoredTrackerConnection) => {
  const c = record.credentials;
  const identity = c.kind === 'jira' ? ['jira', new URL(c.origin).origin, c.email, c.token]
    : c.kind === 'youtrack' ? ['youtrack', new URL(c.origin).origin, c.token]
    : ['linear', c.key];
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
};

/** Data only: no process.env writes, interpolation, shell execution, or parser debug logging. */
export function decodeConnectionEnv(text: string): StoredTrackerConnection {
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || Object.hasOwn(values, match[1]!)) throw new Error('Invalid connection file');
    const parsed = parse(line);
    if (!Object.hasOwn(parsed, match[1]!)) throw new Error('Invalid connection file');
    values[match[1]!] = parsed[match[1]!]!;
  }
  const keys = Object.keys(values).sort().join(',');
  // The secret key names the provider; the strict inventory below rejects a file carrying two.
  const credentials = Object.hasOwn(values, 'JIRA_API_TOKEN')
    ? { kind: 'jira', origin: values.JIRA_BASE_URL, email: values.JIRA_EMAIL, token: values.JIRA_API_TOKEN }
    : Object.hasOwn(values, 'YOUTRACK_TOKEN')
      ? { kind: 'youtrack', origin: values.YOUTRACK_BASE_URL, token: values.YOUTRACK_TOKEN }
      : { kind: 'linear', key: values.LINEAR_API_KEY };
  const providerKeys = credentials.kind === 'jira' ? ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN']
    : credentials.kind === 'youtrack' ? ['YOUTRACK_BASE_URL', 'YOUTRACK_TOKEN'] : ['LINEAR_API_KEY'];
  const expected = ['RECORD_VERSION', 'CONNECTION_ID', 'PROJECT_ROOT', 'CREDENTIAL_SHA256', ...providerKeys].sort().join(',');
  if (values.RECORD_VERSION !== '1' || keys !== expected) throw new Error('Invalid connection file');
  const record = connectionRecordSchema.parse({ id: values.CONNECTION_ID, projectRoot: values.PROJECT_ROOT, credentials });
  // Private consistency check, NOT encryption/authentication. Editing only the key must not
  // preserve the public revision and leave an old provider cached. Re-save through Settings.
  if (values.CREDENTIAL_SHA256 !== digest(record)) throw new Error('Connection needs saving again');
  return record;
}

function value(text: string): string {
  if (/[\x00-\x1f\x7f]/.test(text)) throw new Error('Invalid credential characters');
  // dotenv has no universal JSON/shell escaping convention. Pick a literal delimiter and
  // verify a lossless round trip; double quotes interpret backslash-n/backslash-r.
  for (const quote of ["'", '`', '"', '']) {
    if (quote && text.includes(quote)) continue;
    const encoded = `${quote}${text}${quote}`;
    if (parse(`VALUE=${encoded}`).VALUE === text) return encoded;
  }
  throw new Error('Unsupported credential characters');
}

export function encodeConnectionEnv(input: StoredTrackerConnection): string {
  const record = connectionRecordSchema.parse(input);
  const fields: Record<string, string> = {
    RECORD_VERSION: '1', CONNECTION_ID: record.id, PROJECT_ROOT: record.projectRoot, CREDENTIAL_SHA256: digest(record),
    ...credentialEnv(record.credentials),
  };
  const text = '# Managed by cezar. Rotate credentials in project Settings; do not edit this file.\n'
    + Object.entries(fields).map(([key, content]) => `${key}=${value(content)}\n`).join('');
  if (JSON.stringify(decodeConnectionEnv(text)) !== JSON.stringify(record)) throw new Error('Invalid credential encoding');
  return text;
}
