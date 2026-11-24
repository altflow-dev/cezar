import { z } from 'zod';

/**
 * A task's preview environment (spec 2026-11-24-preview-environments): its app standing in
 * docker on ports of its own, for manual testing at review. The run record embeds one;
 * `packages/cezar/src/runs/store.ts` imports this SAME value for its persistence twin, so the
 * two halves of `contract-parity.runs.test.ts` cannot drift.
 *
 * Ports carry no host on purpose: the cockpit prefixes the hostname the viewer reached cezar
 * on (`window.location.hostname`), so the server never needs to know its public address.
 */

export const previewStatusSchema = z.enum(['building', 'ready', 'failed', 'stopped', 'stale']);

export const previewStopReasonSchema = z.enum([
  'user',
  'archived',
  'deleted',
  'merged',
  'ttl',
  'limit',
  'worktree-removed',
  'cancelled',
  'boot-missing',
]);

export const previewPortSchema = z.object({
  label: z.string(),
  service: z.string(),
  hostPort: z.number().int(),
  path: z.string(),
});

export const previewCredentialSchema = z.object({
  label: z.string(),
  url: z.string().optional(),
  user: z.string(),
  password: z.string(),
});

export const previewStateSchema = z.object({
  status: previewStatusSchema,
  /** `docker compose -p` name — what `down` and a reconcile address. */
  composeProject: z.string(),
  ports: z.array(previewPortSchema),
  /** The host the app was told it lives on (`{host}` in preview.yml) — links still use the
   *  viewer's own hostname, this is what the app's config names. */
  host: z.string().optional(),
  /** Snapshotted at build time: preview.yml on the branch may change afterwards. */
  credentials: z.array(previewCredentialSchema).optional(),
  /** Markdown test notes ("what changed / what to check"). */
  notes: z.string().optional(),
  changedFiles: z.array(z.string()).optional(),
  builtFromSha: z.string().optional(),
  /** `worktreeTreeId` of the worktree at build time — what `stale` compares, so cezar's own
   *  autosave commit (same files, new HEAD) does not make a fresh preview look out of date. */
  builtFromTree: z.string().optional(),
  startedAt: z.string(),
  readyAt: z.string().optional(),
  expiresAt: z.string().optional(),
  stoppedAt: z.string().optional(),
  stopReason: previewStopReasonSchema.optional(),
  error: z.string().optional(),
  /** Built with the task branch's own compose / preview.yml (`trustWorktreeConfig`); a Restart
   *  keeps the same trust. */
  trusted: z.boolean().optional(),
});

export type PreviewStatus = z.infer<typeof previewStatusSchema>;
export type PreviewStopReason = z.infer<typeof previewStopReasonSchema>;
export type PreviewPort = z.infer<typeof previewPortSchema>;
export type PreviewCredential = z.infer<typeof previewCredentialSchema>;
export type PreviewState = z.infer<typeof previewStateSchema>;

// ---- the preview routes (`/runs/:id/preview/*`, phase 3) -----------------------------------

/** `POST /runs/:id/preview/restart` (202) and `POST /runs/:id/preview/stop` (200). The record's
 *  `preview` carries the outcome over the existing `run` SSE; the answer only acknowledges. */
export const previewActionResponseSchema = z.object({ ok: z.literal(true) });
export type PreviewActionResponse = z.infer<typeof previewActionResponseSchema>;

/** `POST /runs/:id/preview/extend` — the new expiry. */
export const previewExtendResponseSchema = z.object({ expiresAt: z.string() });
export type PreviewExtendResponse = z.infer<typeof previewExtendResponseSchema>;

/** `GET /runs/:id/preview/logs?service=&tail=` — a query string, so every value is a string. */
export const previewLogsQuerySchema = z.object({
  service: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'service names are letters, digits, "-", "_" and "."').max(100).optional(),
  tail: z.string().regex(/^\d{1,4}$/, 'tail is a number of lines').optional(),
});
export type PreviewLogsQuery = z.infer<typeof previewLogsQuerySchema>;

export const previewLogsResponseSchema = z.object({ text: z.string() });
export type PreviewLogsResponse = z.infer<typeof previewLogsResponseSchema>;
