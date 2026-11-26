# `tracker.set-state`: move the ticket when the work starts, restore it on cancel

Status: **implemented** (2026-11-26). Extends spec `2026-09-30-workflow-node-editor` (graph
nodes) and §13 of `2026-10-15-ticket-implement-review-workflow` (ticket status).

## Problem

A task launched from a YouTrack ticket (`run.trackerItem`) leaves the ticket in its old state,
for example "Zgłoszona" (`Submitted`), while cezar works on it. Nobody can see from YouTrack that
the ticket has been taken. Before cezar, Cursor's repo rule moved the ticket itself. The ticket
workflows forbid agents from touching the status, and cezar's tracker integration only reads.
§13.1 of the ticket-workflow spec left status changes to YouTrack rules fired by the PR, which
cannot see the start of the work.

The owner also asked that cancelling the task puts the ticket back where it was.

## Design

A new system node:

```yaml
- id: take-ticket
  type: tracker.set-state
  state: In Progress        # the State value's API name, not its localized label
```

Ports: `done`, `unchanged`, `failed`. Outputs: `previous` and `state`.

1. No `run.trackerItem` (an ad-hoc task), `CEZ_DRY_RUN=1`, or no state client (a manager built
   without one, as in tests and headless `cez run`): leave by **`unchanged`** with a note. Nothing
   is sent.
2. Read the issue's current `State` value name (`GET /api/issues/<id>?fields=customFields(name,value(name))`).
3. Already `state`: leave by **`unchanged`** and record nothing. Cezar did not move the ticket,
   so a cancel must not move it either.
4. Otherwise apply the YouTrack command `State {<state>}` (`POST /api/commands`). Commands work
   whether or not the project's State field is a state machine. On success, record
   `run.trackerState = { issue, previous, state }` and leave by **`done`**. On any failure
   (HTTP error, timeout, unknown value, no permission), leave by **`failed`** with the reason in
   a note. The node never throws.

The value name is the API name (`In Progress`). The localized label (`W realizacji`) depends on
the instance's language, and a command written with it fails on an English instance.

### Credentials and the host

The node uses the project's own tracker connection, the same one the YouTrack tab uses
(`TrackerConnections` + `readTrackerAssociation`, through `resolveTrackerAgentEnv`). It needs
no new secret and no new env var. The request is sent only when the ticket URL's origin equals
the connection's `YOUTRACK_BASE_URL` origin. A ticket on another instance is never sent this
instance's token: the node leaves by `failed`.

### Cancel restores

`cancelOne` on an active run with a recorded `trackerState` and no `restoredAt` reads the
issue's current state. If it is still the `state` cezar set, cezar applies `previous` again.
If someone has moved the ticket since, cezar leaves it alone. Either way the outcome is a
lifecycle note, and `restoredAt` is set when the ticket was restored. This is fire-and-forget:
cancel never waits on the network, and a failure is a note.

Only a **cancel** restores. A run that ends `failed` or `review` keeps the ticket where the node
put it, because the work did happen. A queued run never reached the node, so there is nothing
to restore.

### Transitions (AGENTS.md § Changing a mechanism)

The node is synchronous and has no state of its own. An unwired `failed` ends the run as failed,
like every `failed` port. Ticket workflows wire all three ports onward, so a tracker problem
never blocks the work. A restart mid-node re-runs it, which is idempotent: the second visit
reads `state` and leaves by `unchanged`.

The default path is unchanged: a workflow without the node never writes to the tracker. Writing
is opt-in per workflow file, the same model as `preview.up`, and it reaches only the
association's own instance, with the credentials the user already gave cezar for that project.

### Contract

`RunRecord.trackerState?` = `{ issue: string, previous: string, state: string, restoredAt?: string }`.
It is optional, so old run files parse.
