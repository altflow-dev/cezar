import type { RunTrackerItem, TrackerAssociation } from '@open-mercato/cezar-contract';

/**
 * The tracker ticket a task was launched from — `RunRecord.trackerItem` (spec
 * 2026-10-15-ticket-implement-review-workflow §13). The id itself is validated by the contract's
 * `TRACKER_ITEM_ID_RE` before it reaches anything here, which is what makes it safe to splice
 * into a branch name, a commit message and a PR title. A run without one is untouched by every
 * helper below: each returns its input unchanged.
 */

/** Why a client-supplied ticket cannot belong to this project, or null when it can. */
export function trackerItemIssue(item: RunTrackerItem, association: TrackerAssociation | null | undefined): string | null {
  if (!association || association.kind !== item.kind) {
    return `trackerItem: this project has no ${item.kind} tracker associated`;
  }
  if (new URL(item.url).origin !== new URL(association.source.webUrl).origin) {
    return `trackerItem: ${item.id} is not on the associated ${item.kind} instance (${association.source.webUrl})`;
  }
  return null;
}

/**
 * `[TERM-396] <text>` — the ticket prefix for a commit subject or a PR title. Text that already
 * opens with the id (`[TERM-396] …`, `TERM-396: …`, `TERM-396 …`) is left alone, so a title the
 * user or the agent wrote with the ticket in it is not prefixed twice.
 */
export function withTicketPrefix(text: string, ticketId: string | undefined): string {
  if (!ticketId) return text;
  const head = text.trimStart();
  if (head.startsWith(`[${ticketId}]`)) return text;
  if (head.startsWith(ticketId) && !/[A-Za-z0-9_-]/.test(head.charAt(ticketId.length))) return text;
  return `[${ticketId}] ${text}`;
}

/**
 * The draft PR title (spec 2026-10-15 §13). Without a ticket: the explicit title, else the run's —
 * exactly as before. With one: `[TERM-396] <title>`, where the title is the explicit one (a
 * `github.draft-pr` node's), else the user's own rename, else the ticket summary, else the run's.
 */
export function draftPrTitle(
  run: { title: string; titleOrigin?: string; trackerItem?: RunTrackerItem },
  explicit?: string,
): string {
  const item = run.trackerItem;
  if (!item) return explicit ?? run.title;
  const title = explicit ?? (run.titleOrigin === 'user' ? run.title : (item.title ?? run.title));
  return withTicketPrefix(title, item.id);
}

/** The PR body with the ticket link on top; unchanged for a task with no ticket. */
export function withTicketLink(body: string, item: RunTrackerItem | undefined): string {
  return item ? `YouTrack: [${item.id}](${item.url})\n\n${body}` : body;
}
