# `git.set-base` — re-point a task's base branch from inside a workflow

Status: **implemented** (2026-11-25). Extends spec `2026-09-30-workflow-node-editor` (graph
nodes). Builds on altflow-dev/cezar#12 (`CEZ_BASE_BRANCH` / `CEZ_BASE_REF`).

## Problem

A task's worktree is forked in `RunManager.execute` (`workflows/run.ts`, `chooseForkBase`)
from the project's configured `baseBranch` or the checked-out branch. That happens before any
agent has read the ticket. Tracker work is not always based on the configured branch: a
YouTrack epic or the message attached to the task may say "base: staging". No graph node can
change the base afterwards. So the implementer either works on the wrong base, or it merges
the right one into the task branch. Every base-derived surface is then wrong: the diff
anchor, `diffStat`, the Changes tab, `CEZ_BASE_BRANCH` / `CEZ_BASE_REF` and the draft PR's
`--base`.

Live case: spsystem SPM-404 forked from `origin/dev`. The agent merged `staging`, and
agent-verify saw 149 changed files.

## Design

A new system node, `git.set-base`:

```yaml
- id: base
  type: git.set-base
  branch: '{{nodes.read-ticket.base}}'   # templated: {{task}}, {{nodes.<id>.<field>}}
  fallback: dev                          # optional; used when `branch` renders empty
```

Ports: `done`, `unchanged`, `refused`, `failed`. Outputs: `base` (the ref now recorded) and
`previous` (the ref before).

1. Render `branch` with the usual node templates and trim it. If it is empty, use `fallback`,
   rendered the same way. A check reader that printed nothing records `(no output)`, which
   counts as empty here, so "the ticket named no base" takes the fallback. If both are empty, leave by **`unchanged`**: the run keeps the base
   it forked from. Spelling is normalised: a leading `refs/heads/` or `origin/` is stripped.
2. The name must pass `isSafeGitRef` and `git check-ref-format refs/heads/<name>`.
   Otherwise leave by **`failed`**.
3. Resolve it with `resolveBaseRef` (fetch first, prefer `origin/<branch>` unless the local
   branch is equal or ahead), which is the same rule as the fork. Unknown locally and on
   origin means **`failed`**.
4. If the resolved ref equals the recorded `run.baseBranch`, leave by **`unchanged`**.
5. Re-fork only while the task has done no work. The worktree must be clean
   (`git status --porcelain` is empty; ignored files don't count, so seeded agent config is
   fine), and `HEAD` must be an ancestor of the recorded base. That means no commits beyond
   the fork, and it survives the base moving on after the fork. Otherwise leave by
   **`refused`** and change nothing.
6. `git reset --hard <sha of the new ref>` on the task branch, inside the task worktree.
   Then `run.baseBranch = <resolved ref>`, and refresh `diffStat` from the new anchor.
   Leave by **`done`**.

A task with no worktree of its own (`worktree: false`, not a git repo) leaves by `failed`.
Resetting the user's working tree is never an option. The node never throws, and every
outcome is a note on the rail.

### Why every surface follows

All of them read `run.baseBranch` at use time. `taskBaseEnv` covers `CEZ_BASE_*` at every
spawn. `worktreeShortstat`, `worktreeChangedFiles` and the Changes tab go through
`resolveTaskDiffBase`. `createDraftPr` takes `--base` from `run.baseBranch` minus `origin/`.
Nothing caches the base, so updating the record is the whole migration. HEAD stays on the
task branch, so the #751 "repointed HEAD" path is not triggered.

### Transitions (AGENTS.md § Changing a mechanism)

The node adds no state. It runs synchronously and leaves by one of four ports. An unwired
`refused` or `failed` ends the run as failed (`isFailurePort`: `failed` is already a failure
port, and `refused` is added). An unwired `unchanged` or `done` continues as success. A
restart mid-node re-runs it. That is idempotent: a second visit sees the new base recorded
and leaves by `unchanged`.

The default path is unchanged. A workflow without the node forks exactly as before.

## Intended use (follow-up, not in this change)

Ticket workflows (`ticket-implement-review*.yaml`) gain an early agent node, before the
implementer. It reads the epic and the attached message and outputs the base it names. A
`git.set-base` with `fallback: dev` follows it. The owner's rule is that when neither names
a base, the base is `dev`. Wire `refused` to a `gate.human`.
