import { posix } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * `.ai/cezar/preview.yml` — how to stand a task's app up in docker for manual testing
 * (spec 2026-11-24-preview-environments). A committed, AUTHORED file, so it is `.strict()`:
 * an unknown key is a typo the author wants to hear about, not state to carry forward.
 *
 * Every key is optional. Without the file a discovered compose file is used as-is, every
 * published port becomes a link, and there is no seed and no credentials.
 */

export const PREVIEW_CONFIG_PATH = '.ai/cezar/preview.yml';

/** Compose's own discovery order (`docker compose` without `-f`). */
export const COMPOSE_CANDIDATES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'] as const;

/** A repo-relative path that stays inside the repo: no absolute path, no `..` segment. */
const repoPath = z
  .string()
  .min(1)
  .refine((p) => !posix.isAbsolute(p) && !/^[A-Za-z]:/.test(p), 'must be a path relative to the repository root')
  .refine((p) => !posix.normalize(p).split('/').includes('..'), 'must stay inside the repository (no "..")');

const label = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/, 'labels are letters, digits, spaces, "-" and "_" (max 40)');
const service = z.string().min(1);
const urlPath = z.string().startsWith('/', 'paths start with "/"');

export const previewConfigSchema = z
  .object({
    compose: z.union([repoPath, z.array(repoPath).min(1)]).optional(),
    copyFromRoot: z.array(repoPath).optional(),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'env names are shell identifiers'), z.string()).optional(),
    expose: z
      .record(label, z.object({ service, port: z.number().int().min(1).max(65535), path: urlPath.default('/') }).strict())
      .optional(),
    ready: z
      .object({
        /** An `expose` label; the first one when omitted. */
        url: z.string().optional(),
        path: urlPath.default('/'),
        timeoutSec: z.number().int().min(10).max(1800).default(300),
      })
      .strict()
      .optional(),
    /** Environment set on one service for the preview only (it overrides the service's
     *  `env_file` and `environment`). `{host}`, `{port:<label>}` and `{url:<label>}` are replaced
     *  with the preview's public host, an exposed label's host port and its full URL — what an app
     *  needs to name itself: `NEXT_PUBLIC_API_URL: "{url:backend}"`. */
    serviceEnv: z
      .record(service, z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'env names are shell identifiers'), z.string()))
      .optional(),
    seed: z.array(z.object({ service, command: z.string().min(1) }).strict()).optional(),
    credentials: z
      .array(
        z
          .object({ label: z.string().min(1), url: z.string().optional(), user: z.string().min(1), password: z.string() })
          .strict(),
      )
      .optional(),
    checklistHints: z.string().optional(),
  })
  .strict();

export type PreviewConfig = z.infer<typeof previewConfigSchema>;

/** Reads a repo-relative file, or null when it does not exist. */
export type RepoFileReader = (path: string) => Promise<string | null>;

export type LoadedPreviewConfig =
  | {
      ok: true;
      /** False when no `preview.yml` exists and the compose file was discovered. */
      fromFile: boolean;
      config: PreviewConfig;
      /** Repo-relative compose files, in `-f` order. */
      composeFiles: string[];
      warnings: string[];
    }
  | { ok: false; error: string };

/** Strings that look like a real secret rather than a seeded test password. */
const SECRET_SHAPES = [/^sk-[A-Za-z0-9_-]{16,}/, /^gh[pousr]_[A-Za-z0-9]{20,}/, /^xox[abpr]-/, /^AKIA[0-9A-Z]{16}$/, /^[A-Za-z0-9+/=_-]{40,}$/];

export function looksLikeSecret(value: string): boolean {
  return SECRET_SHAPES.some((re) => re.test(value));
}

/**
 * Load and validate the preview config through `read` (the base branch or the worktree — the
 * caller decides which is trusted). Never throws: every problem is `{ ok: false, error }` with a
 * sentence the run's rail can show as is.
 */
export async function loadPreviewConfig(read: RepoFileReader): Promise<LoadedPreviewConfig> {
  const raw = await read(PREVIEW_CONFIG_PATH);
  let config: PreviewConfig = {};
  const warnings: string[] = [];
  if (raw !== null) {
    let doc: unknown;
    try {
      doc = parseYaml(raw) ?? {};
    } catch (err) {
      return { ok: false, error: `${PREVIEW_CONFIG_PATH} is not valid YAML — ${err instanceof Error ? err.message : String(err)}` };
    }
    const parsed = previewConfigSchema.safeParse(doc);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.length ? issue.path.join('.') : '(root)';
      return { ok: false, error: `${PREVIEW_CONFIG_PATH}: ${where} — ${issue?.message ?? 'invalid'}` };
    }
    config = parsed.data;
    for (const c of config.credentials ?? []) {
      if (looksLikeSecret(c.password)) {
        warnings.push(`credential "${c.label}" looks like a real secret — preview.yml is shown to every cockpit user`);
      }
    }
  }

  let composeFiles: string[];
  if (config.compose) {
    composeFiles = Array.isArray(config.compose) ? config.compose : [config.compose];
    for (const f of composeFiles) {
      if ((await read(f)) === null) return { ok: false, error: `compose file "${f}" named in ${PREVIEW_CONFIG_PATH} does not exist` };
    }
  } else {
    let found: string | undefined;
    for (const candidate of COMPOSE_CANDIDATES) {
      if ((await read(candidate)) !== null) {
        found = candidate;
        break;
      }
    }
    if (!found) {
      return {
        ok: false,
        error: `no compose file found (looked for ${COMPOSE_CANDIDATES.join(', ')}) — add one, or name it in ${PREVIEW_CONFIG_PATH} under "compose"`,
      };
    }
    composeFiles = [found];
  }

  const labels = Object.keys(config.expose ?? {});
  if (config.ready?.url && !labels.includes(config.ready.url)) {
    return { ok: false, error: `${PREVIEW_CONFIG_PATH}: ready.url "${config.ready.url}" is not one of the expose labels (${labels.join(', ') || 'none'})` };
  }
  for (const c of config.credentials ?? []) {
    if (c.url && !labels.includes(c.url)) {
      return { ok: false, error: `${PREVIEW_CONFIG_PATH}: credential "${c.label}" points at url "${c.url}", which is not an expose label` };
    }
  }
  return { ok: true, fromFile: raw !== null, config, composeFiles, warnings };
}
