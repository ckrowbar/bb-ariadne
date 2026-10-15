# Cyril v0 spec

Status: draft for discussion, 2026-10-15.

## Goal

One Cyril thread per workstream acts as the user's main contact. It keeps the
workstream's knowledge, spawns and steers worker threads for named tasks, and
tracks what each worker is doing, including what it has put on staging. Cyril
is autonomous: it spawns and steers without asking, and escalates only on the
cases listed below.

Every key human interaction is a click in the BB app. The CLI exists for
agents and scripting, not as the user's interface.

## Concepts

- **Workstream.** A free-form name such as `chat-store` or `hackathon-q4`,
  with optional untyped links (Jira epic, docs, repos). There is no Jira
  coupling. One Cyril thread per workstream.
- **Task.** One unit of work handed to one worker, usually a ticket the user
  names. A task belongs to one workstream.
- **Worker.** A child thread of Cyril that runs one task in its own BB-managed
  worktree.
- **Staging log.** A record of what each worker integrated into the shared
  staging branch, when, and why. Staging is a shared merge branch
  (`chat-integrate <service>` "Integrate[s] a service to the staging branch"),
  so this is a log, not a lock.

## How Cyril knows what to do

| Layer | What | Where |
| --- | --- | --- |
| Standing orders | Role, autonomy, escalation rules, playbooks | Static instructions from `configure()` |
| State | Notes, board, staging log | Plugin SQLite, read through tools |
| Triggers | User messages, BB `child-completed`, worker reports, heartbeat digests | Arrive as turns on the Cyril thread |

Board state is read through tools, not injected into instructions. The plugin
docs say "a live provider session keeps the instructions it was constructed
with", so injected state would go stale.

### Playbooks (part of the standing orders)

- **User names a task.** Read the ticket or links (dd_tools for Jira). Check the
  board for overlapping in-flight tasks. Write a kickoff: goal and definition
  of done, context from notes, constraints, siblings in flight. Spawn the
  worker. Tell the user in one line.
- **`child-completed` arrives.** Read the output. Update the task. Fold durable
  facts into notes and mark the task harvested. Summarise for the user only
  what they need to act on.
- **Worker reports `blocked`.** Answer from notes and steer the worker if
  possible. Otherwise escalate.
- **Heartbeat digest arrives.** Act on each item. Stay silent if nothing needs
  the user.

### Escalate to the user when

- The ticket is ambiguous and notes do not resolve it.
- Two workers collide (same files, or one's staging change breaks another's
  test).
- A worker wants to change the staging branch itself rather than integrate
  into it, because that affects teammates.
- An action would post outside BB (Slack, Jira comments, PR comments).
- Anything would merge, mark a PR ready, or deploy beyond staging.

## Workers and environments

Workers run in BB-managed worktrees of a dd-source BB project, based on
`origin/main` unless the kickoff says otherwise. This replaces the current
habit of workers running `git worktree add ~/dd/dd-source-<ticket>` by hand.
It gives:

- isolation that does not depend on each worker remembering to make a worktree
- a branch BB knows about, so `bb.sdk.environments.pullRequest` reports PR
  state, checks and mergeability
- cleanup when the task's thread is archived

Fallback when a task has no repo: a personal workspace.

To verify before building: whether a worker can rename its managed-worktree
branch to the `cyrus.kalafchi/CHATINTS-XXXX/<slug>` convention, and whether
PR detection works after that rename.

## Data model (plugin SQLite)

```sql
workstreams(name PRIMARY KEY, cyril_thread_id, links_json, created_at)
notes(workstream, topic, body, revision, updated_at, PRIMARY KEY (workstream, topic))
note_revisions(workstream, topic, revision, body, written_by_thread_id, written_at)
tasks(id PRIMARY KEY, workstream, title, links_json, worker_thread_id,
      environment_id, status, pr_url, summary, harvested, updated_at)
staging_log(id PRIMARY KEY, at, worker_thread_id, task_id, service, branch, purpose)
events(id PRIMARY KEY, at, workstream, task_id, kind, detail)  -- audit trail
```

Task `status`: `running`, `blocked`, `in-review`, `done`, `dropped`.

Notes are written only by machines (Cyril and the plugin). Every write keeps
the previous revision, so a bad update can be rolled back. Suggested starting
topics: `overview`, `people`, `architecture`, `conventions`, `gotchas`.

## Agent tools

Selected per role by `configure()` from thread plugin metadata (verified in
the spike).

**Cyril threads**

| Tool | Does |
| --- | --- |
| `cyril_spawn_worker(title, prompt, links?, model?, baseBranch?)` | Creates the task row and a child worker in a new managed worktree |
| `cyril_board(status?)` | Lists this workstream's tasks, with PR state where known |
| `cyril_task_update(taskId, status?, prUrl?, summary?, harvested?)` | Edits a task |
| `cyril_notes_read(topic?)` / `cyril_notes_write(topic, body)` | Reads or replaces a note topic |
| `cyril_staging(limit?)` | Lists recent staging log entries across all workstreams |

**Worker threads**

| Tool | Does |
| --- | --- |
| `cyril_report(status, note, prUrl?)` | `pr-opened`, `blocked`, `fyi` or `done`. Updates the task and tells Cyril with `senderThreadId` set |
| `cyril_staging_log(service, branch, purpose)` | Records an integration into staging. Workers call it right after `chat-integrate` |

Worker instructions explain the protocol and name the Cyril thread. They do
not list siblings, because instructions go stale; Cyril puts siblings in the
kickoff prompt.

## Events and heartbeat

| Source | Plugin does |
| --- | --- |
| BB `child-completed` | Nothing. BB delivers it to Cyril natively (spike finding 1) |
| `interaction.pending` on a worker | Tells Cyril at once. An autonomous worker stuck on a permission prompt or question is otherwise invisible |
| `thread.archived` / `thread.deleted` on a worker | Marks the task `dropped` if still `running` |

**Heartbeat.** A plugin timer that looks for things nobody reports. The checks
are plain code and cost no model turns:

- workers idle with task status `running` for over 30 minutes
- PR changes for worktree workers: checks failing, conflicts, merged
- `done` tasks not yet harvested into notes
- staging log entries from different workstreams in the same hour, for the same service

It sends Cyril one digest only when something changed. It ticks every 10
minutes while there is activity and stops after 60 minutes with no changes.
Any spawn, worker report or worker lifecycle event restarts it.

## UI

v0 uses stable plugin slots only (`app.slots.navPanel`,
`app.slots.threadPanelAction`, `app.slots.homepageSection`). Thread links
open threads through BB navigation.

| Human interaction | Where you click |
| --- | --- |
| Start a workstream | **Cyril** sidebar page → **New workstream** (name, optional links). Creates a pinned Cyril thread and opens it |
| Talk to Cyril, hand it a ticket | The pinned Cyril thread. Plain chat |
| See what is going on | **Cyril** page → workstream → **Board** tab: one row per task with status, PR and CI badges. Click a row to open the worker thread, or the badge to open the PR |
| Same, without leaving the chat | **Board** thread panel on the Cyril thread, same rows beside the conversation |
| Answer an escalation | Cyril asks with the provider's native question UI so answers are clicks. The SDK says a provider with `supportsNativeUserQuestion` has its questions routed "into the pending-interaction path"; to verify for Claude Code before building. Free-form questions are ordinary chat |
| Unstick a worker waiting on approval | Cyril's alert links the worker thread. BB's native approve or deny controls are there |
| Check what Cyril knows | **Notes** tab: read-only topics with revision history |
| See what is on staging | **Staging** tab: recent integrations by service, branch, worker and time, across workstreams |
| Drop a task | **Drop** on the board row. Archives the worker thread and marks the task `dropped` |
| Glance at everything | Home page section: each workstream with counts of running, blocked and in-review tasks |
| Retire a workstream | **Archive** on the workstream page. Archives the Cyril thread and its workers |

Data reaches the UI through plugin RPC, and a realtime signal refreshes open
views when the board, notes or staging log change.

Later, if useful: a status chip in the Cyril thread header
(`experimental_threadHeaderAction`) and `#task` mentions in the composer
(`bb.ui.registerMentionProvider`).

## CLI

For agents and scripting.

```
bb cyril create <workstream> [--project <id>] [--link <url>]...
bb cyril list                      # workstreams and their Cyril threads
bb cyril board <workstream>
bb cyril notes <workstream> [topic]
bb cyril staging [--limit <n>]
```

## Out of scope for v0

- Editing notes in the UI. Notes are machine-maintained; the UI is read-only.
- Enforcing anything through the `message.dispatch` hook. It is experimental.
- Multi-machine correctness. The plugin assumes the server and workers share
  a host.
- Teammates' staging changes. The log covers only Cyril workers.

## Open questions

1. Is a 30-minute idle threshold right for "stuck worker"?
