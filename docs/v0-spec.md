# Cyril v0 spec

Status: draft for discussion, 2026-10-15.

## Goal

One Cyril thread per workstream acts as the user's main contact. It keeps the
workstream's knowledge, spawns and steers worker threads for named tasks,
tracks what each worker is doing, and coordinates the shared staging
environment. Cyril is autonomous: it spawns and steers without asking, and
escalates only on the cases listed below.

v0 is backend-only. No UI.

## Concepts

- **Workstream.** A free-form name such as `chat-store` or `hackathon-q4`,
  with optional untyped links (Jira epic, docs, repos). There is no Jira
  coupling. One Cyril thread per workstream.
- **Task.** One unit of work handed to one worker, usually a ticket the user
  names. A task belongs to one workstream.
- **Worker.** A child thread of Cyril that runs one task.
- **Claim.** A lock on a shared resource. v0 has one resource, `staging`. Claims
  are global across workstreams, because staging is shared.

## How Cyril knows what to do

| Layer | What | Where |
| --- | --- | --- |
| Standing orders | Role, autonomy, escalation rules, playbooks | Static instructions from `configure()` |
| State | Notes, board, claims | Plugin SQLite, read through tools |
| Triggers | User messages, BB `child-completed`, worker reports, heartbeat digests | Arrive as turns on the Cyril thread |

Board state is read through tools, not injected into instructions. The plugin
docs say "a live provider session keeps the instructions it was constructed
with", so injected state would go stale.

### Playbooks (part of the standing orders)

- **User names a task.** Read the ticket or links (dd_tools for Jira). Check the
  board for overlapping in-flight tasks. Write a kickoff: goal and definition
  of done, context from notes, constraints, siblings in flight. Spawn the
  worker. Tell the user in one line.
- **`child-completed` arrives.** Read the output. Update the task. Save durable
  facts to notes. Summarise for the user only what they need to act on.
- **Worker reports `blocked`.** Answer from notes and steer the worker if
  possible. Otherwise escalate.
- **Heartbeat digest arrives.** Act on stale claims, stuck workers and pending
  interactions. Stay silent if nothing needs the user.

### Escalate to the user when

- The ticket is ambiguous and notes do not resolve it.
- Two workers collide (same files, same staging window).
- An action would post outside BB (Slack, Jira comments, PR comments).
- Anything would merge, mark a PR ready, or deploy beyond staging.

## Data model (plugin SQLite)

```sql
workstreams(name PRIMARY KEY, cyril_thread_id, links_json, created_at)
notes(workstream, topic, body, updated_at, PRIMARY KEY (workstream, topic))
tasks(id PRIMARY KEY, workstream, title, links_json, worker_thread_id,
      status, pr_url, summary, updated_at)
claims(resource PRIMARY KEY, holder_thread_id, task_id, reason, claimed_at)
events(id PRIMARY KEY, at, workstream, task_id, kind, detail)  -- audit trail
```

Task `status`: `running`, `blocked`, `in-review`, `done`, `dropped`.

Note topics are free-form. Suggested starting set: `overview`, `people`,
`architecture`, `conventions`, `gotchas`.

## Agent tools

Selected per role by `configure()` from thread plugin metadata (verified in
the spike).

**Cyril threads**

| Tool | Does |
| --- | --- |
| `cyril_spawn_worker(title, prompt, links?, model?, environment?)` | Creates the task row and a child worker thread |
| `cyril_board(status?)` | Lists this workstream's tasks |
| `cyril_task_update(taskId, status?, prUrl?, summary?)` | Edits a task |
| `cyril_notes_read(topic?)` / `cyril_notes_write(topic, body)` | Reads or replaces a note topic |
| `cyril_claims()` / `cyril_claim_release(resource)` | Shows or force-releases claims |

**Worker threads**

| Tool | Does |
| --- | --- |
| `cyril_report(status, note, prUrl?)` | `pr-opened`, `blocked`, `fyi` or `done`. Updates the task and tells Cyril with `senderThreadId` set |
| `cyril_claim(resource, reason)` | Takes the claim or returns the current holder and since when |
| `cyril_release(resource)` | Releases the caller's claim |

Worker instructions explain the protocol and name the Cyril thread. They do
not list siblings, because instructions go stale; Cyril puts siblings in the
kickoff prompt.

## Events and background work

| Source | Plugin does |
| --- | --- |
| BB `child-completed` | Nothing. BB delivers it to Cyril natively (spike finding 1) |
| `interaction.pending` on a worker | Tells Cyril at once. An autonomous worker stuck on a permission prompt or question is otherwise invisible |
| `thread.archived` / `thread.deleted` on a worker | Releases its claims. Marks the task `dropped` if still `running` |
| Heartbeat schedule, default every 30 min | Checks stale claims (held over 4h, or holder idle over 1h) and workers idle with status `running`. Sends Cyril one digest only when something changed |

## CLI

```
bb cyril create <workstream> [--project <id>] [--link <url>]...
bb cyril list                      # workstreams and their Cyril threads
bb cyril board <workstream>
bb cyril notes <workstream> [topic]
bb cyril claims [--release <resource>]
```

## Out of scope for v0

- UI (board panel). Revisit after a few weeks of use.
- Enforcing claims through the `message.dispatch` hook. It is experimental,
  and the tool protocol may be enough.
- PR polling. `bb.sdk.environments.pullRequest` reads PR state from a thread's
  environment branch. Workers in personal workspaces work inside other
  checkouts, so BB sees no PR there. v0 relies on `cyril_report(prUrl)`.
- Multi-machine correctness. The plugin assumes the server and workers share
  a host.
- Teammates' use of staging. Claims cover only Cyril workers.

## Open questions

1. Notes in SQLite (tool access only, portable) or markdown files you can open
   in the IDE? The draft uses SQLite plus `bb cyril notes` for reading.
2. Are 4h for a stale claim and 30 min for the heartbeat reasonable?
3. Default worker environment: personal workspace (what you use today) or a
   managed worktree of a project?
4. Should the heartbeat run only during working hours?
