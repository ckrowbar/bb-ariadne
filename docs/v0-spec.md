# Ariadne v0 spec

Status: built, 2026-10-15. Renamed from Cyril to Ariadne the same day.

## Goal

One Ariadne thread per workstream acts as the user's main contact. It keeps the
workstream's knowledge, spawns and steers worker threads for named tasks, and
tracks what each worker is doing, including what it has put on staging. Ariadne
is autonomous: it spawns and steers without asking, and escalates only on the
cases listed below.

Every key human interaction is a click in the BB app. The CLI exists for
agents and scripting, not as the user's interface.

## Concepts

- **Workstream.** A free-form name such as `chat-store` or `hackathon-q4`,
  with optional untyped links (Jira epic, docs, repos). There is no Jira
  coupling. One Ariadne thread per workstream.
- **Task.** One unit of work handed to one worker, usually a ticket the user
  names. A task belongs to one workstream.
- **Worker.** A child thread of Ariadne that runs one task in its own BB-managed
  worktree.
- **Staging log.** A record of what each worker integrated into the shared
  staging branch, when, and why. Staging is a shared merge branch
  (`chat-integrate <service>` "Integrate[s] a service to the staging branch"),
  so this is a log, not a lock.

## How Ariadne knows what to do

| Layer | What | Where |
| --- | --- | --- |
| Standing orders | Role, autonomy, escalation rules, playbooks | Static instructions from `configure()` |
| State | Notes, board, staging log | Plugin SQLite, read through tools |
| Triggers | User messages, BB `child-completed`, worker reports, heartbeat digests | Arrive as turns on the Ariadne thread |

Board state is read through tools, not injected into instructions. The plugin
docs say "a live provider session keeps the instructions it was constructed
with", so injected state would go stale.

### Playbooks (part of the standing orders)

- **User names a task.** Read the ticket or links (dd_tools for Jira). Check the
  board for overlapping in-flight tasks. Write a kickoff: goal and definition
  of done, context from notes, constraints, siblings in flight. Spawn the
  worker. Tell the user in one line.
- **`child-completed` or a `done` report arrives.** Read the output. Update the
  task. Fold durable facts into notes and mark the task harvested. Summarise
  for the user only what they need to act on. Stay silent when it repeats a
  report or answers a question the user asked the worker directly.
- **Worker reports `blocked`.** Answer from notes and steer the worker if
  possible. Otherwise escalate.
- **Plugin message arrives** (digest, worker report, stalled worker). Act on
  each item. If nothing needs the user, end the turn with no text.

Plugin messages are sent as agent-only input, so they wake Ariadne but do not
appear in its thread. The user sees only Ariadne's replies; the board's event
log keeps the record.

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

Workers spawn with `permissionMode: "full"`, matching how the user's earlier
autonomous ticket threads ran. Under the default sandbox, a test worker
stalled on "Allow network connection to 127.0.0.1?" after a plain `git`
command.

### Worktree test findings (2026-10-15)

dd-source is registered as BB project `proj_jqj7vvv6ad`.

- **Base refresh is the blocker.** With the default base or
  `--base-branch origin/main`, BB first runs
  `git fetch --quiet origin +refs/heads/main:refs/remotes/origin/main`. That
  uses SSH, and SSH only works while the user's laptop forwards its agent, so
  provisioning failed. A local base (`--base-branch main`) skips the fetch, but
  local `main` was 24 hours old.
  - Fix (built, verified): before each spawn, the plugin fetches the base
    branch over token-authenticated HTTPS (ddtool for Datadog orgs, stored gh
    credentials otherwise) and passes the resulting commit as the base. BB
    accepts a commit SHA without fetching. The e2e worker's base was 86 s old.
- **Branch names.** BB names the branch `bb/<title-slug>-<thread-id>`. A worker
  can `git branch -m` to the user's convention; BB shows the new name after its
  next status refresh. The plugin records the worktree's current branch on
  each heartbeat (active tasks only), on every `ariadne_report`, and from the
  `branch` argument of `ariadne_staging_log`, so a rename shows up even if the
  task finishes between heartbeats.
- **PR detection works**, including checks: "#123379 draft ... Checks: pending
  (10 passed, 0 failed, 1 pending, 11 total)". BB's GitHub access does not
  need SSH.
- **Cost.** Checking out dd-source took 51 s. Teardown took about 2 min.
- **Teardown leaves local branches.** The plugin deletes a worker's local
  branch after teardown only if every commit on it is already upstream.
- **BB retires archived worktrees itself.** Archiving a thread puts its
  environment in `retiring` with a deadline about 5 minutes out, then BB tears
  it down, whatever its state. So the plugin cannot keep a worktree. It warns
  Ariadne during that window when work is at risk (unarchiving keeps it), and the
  Drop dialog shows the risk before you confirm.
- **Environment ids arrive late.** `threads.spawn` returns before provisioning,
  so `environmentId` is null at spawn. The plugin resolves it from the thread
  when it first needs it.
- **Questions are clickable.** Claude Code's question tool became a
  `question` interaction with options. A question asked while another
  interaction is pending fails, so the worker has to ask again.

## Data model (plugin SQLite)

```sql
workstreams(name PRIMARY KEY, ariadne_thread_id, links_json, created_at)
notes(workstream, topic, body, revision, updated_at, PRIMARY KEY (workstream, topic))
note_revisions(workstream, topic, revision, body, written_by_thread_id, written_at)
tasks(id PRIMARY KEY, workstream, title, links_json, worker_thread_id,
      environment_id, status, pr_url, summary, harvested, updated_at)
staging_log(id PRIMARY KEY, at, worker_thread_id, task_id, service, branch, purpose)
events(id PRIMARY KEY, at, workstream, task_id, kind, detail)  -- audit trail
lessons(id PRIMARY KEY, text, source_thread_id, created_at)    -- global
branch_cleanup(environment_id PRIMARY KEY, repo_path, branch, base_ref, attempts, requested_at)
digest_state(key PRIMARY KEY, signature, updated_at)          -- heartbeat dedupe
```

Task `status`: `running`, `blocked`, `in-review`, `done`, `dropped`. A worker's
`done` report keeps the task `in-review` while its PR is open; the heartbeat
moves it to `done` when the PR merges.

Notes are written only by machines (Ariadne and the plugin). Every write keeps
the previous revision, so a bad update can be rolled back. Suggested starting
topics: `overview`, `people`, `architecture`, `conventions`, `gotchas`.

## Agent tools

Selected per role by `configure()` from thread plugin metadata (verified in
the spike).

**Ariadne threads**

| Tool | Does |
| --- | --- |
| `ariadne_spawn_worker(title, prompt, links?, model?, baseBranch?)` | Creates the task row and a child worker in a new managed worktree |
| `ariadne_board(status?)` | Lists this workstream's tasks: status, harvested, worker, branch, PR and checks state, summary. `bb ariadne board` prints the same row |
| `ariadne_task_update(taskId, status?, prUrl?, summary?, harvested?)` | Edits a task |
| `ariadne_notes_read(topic?)` / `ariadne_notes_write(topic, body)` | Reads or replaces a note topic |
| `ariadne_staging(limit?)` | Lists recent staging log entries across all workstreams |
| `ariadne_lesson_add(text)` / `ariadne_lesson_remove(id)` | Saves or removes a global lesson (see Self-improvement) |
| `ariadne_improve(title, problem, evidence?, proposal?)` | Spawns an improvement worker in the plugin repo (see Self-improvement) |

**Worker threads**

| Tool | Does |
| --- | --- |
| `ariadne_report(status, note, prUrl?)` | `pr-opened`, `blocked`, `fyi` or `done`. Updates the task and tells Ariadne with `senderThreadId` set |
| `ariadne_staging_log(service, branch, purpose)` | Records an integration into staging. Workers call it right after `chat-integrate` |

Worker instructions explain the protocol and name the Ariadne thread. They do
not list siblings, because instructions go stale; Ariadne puts siblings in the
kickoff prompt.

## Events and heartbeat

| Source | Plugin does |
| --- | --- |
| BB `child-completed` | BB delivers it to Ariadne natively (spike finding 1). A `message.dispatch` hook rejects it when the worker sent a `pr-opened`, `blocked` or `done` report during that turn, or when the user started the turn in the worker thread. Ariadne then gets one message per event. A steer from Ariadne into the running turn clears both, so Ariadne gets the answer it asked for |
| `interaction.pending` on a worker | Tells Ariadne at once. An autonomous worker stuck on a permission prompt or question is otherwise invisible |
| `thread.archived` on a worker | Marks the task `dropped` if still `running`. Warns Ariadne if work is at risk before BB retires the worktree; otherwise queues the local branch for deletion after teardown |
| `thread.archived` on a Ariadne thread | Marks the workstream archived |

**Heartbeat.** A plugin timer that looks for things nobody reports. The checks
are plain code and cost no model turns:

- workers idle with task status `running` for over 30 minutes
- PR changes for worktree workers: checks failing, conflicts, review
  changes, merged (merged moves an `in-review` task to `done`). Draft,
  checks-pending and queued PRs are quiet; the worker already reported the PR
- pending branch cleanups (this runs even while the heartbeat is quiet)
- `done` tasks not yet harvested into notes
- staging log entries from different workstreams in the same hour, for the same service

It sends Ariadne one digest only when something changed. It ticks every 10
minutes while there is activity and stops after 60 minutes with no changes.
Any spawn, worker report or worker lifecycle event restarts it.

## Self-improvement

The user can ask Ariadne to fix or improve itself, and Ariadne suggests it when a
problem is clearly its own. There are two paths:

- **Lessons**, for behaviour that remembering can fix (a preference, a
  playbook tweak). `ariadne_lesson_add` stores a global lesson. Every Ariadne
  receives lessons through `contributeInstructions`, which has its own
  4096-character budget, so lessons never push the standing orders past BB's
  cap. A live session keeps its instructions, so other Ariadne threads pick a lesson up
  at their next session. Lessons are listed, and removable, on the Ariadne page.
- **Code**, for anything else. `ariadne_improve` spawns a worker in a managed
  worktree of the plugin repo (BB project set by the `pluginProjectId` setting;
  `.bb-env-setup.sh` runs `npm ci`). The worker typechecks, builds, pushes a
  branch and opens a draft PR in the plugin repo (read from the project's git
  remote). It never touches the
  live plugin checkout.
- **Applying.** Nothing changes until the user merges and asks Ariadne to apply
  it. Ariadne then pulls the checkout, runs `npm ci` if the lockfile changed,
  builds and reloads the plugin. A reviewed PR is the guard against Ariadne
  widening its own permissions.

Verified 2026-10-15: lesson 1 (Haiku for throwaway tasks) was followed on the
next spawn, and an improvement request produced
[ckrowbar/bb-ariadne#1](https://github.com/ckrowbar/bb-ariadne/pull/1).

## UI

v0 uses stable plugin slots only (`app.slots.navPanel`,
`app.slots.threadPanelAction`, `app.slots.homepageSection`). Thread links
open threads through BB navigation.

| Human interaction | Where you click |
| --- | --- |
| Start a workstream | **Ariadne** sidebar page → **New workstream** (name, optional links). Creates a pinned Ariadne thread and opens it |
| Talk to Ariadne, hand it a ticket | The pinned Ariadne thread. Plain chat |
| See what is going on | **Ariadne** page → workstream → **Board** tab: one row per task with status, PR and CI badges. Click a row to open the worker thread, or the badge to open the PR |
| Same, without leaving the chat | **Board** thread panel on the Ariadne thread, same rows beside the conversation |
| Answer an escalation | Ariadne asks with the provider's native question UI so answers are clicks. Verified for Claude Code in the worktree test. Free-form questions are ordinary chat |
| Unstick a worker waiting on approval | Ariadne's alert links the worker thread. BB's native approve or deny controls are there |
| Check what Ariadne knows | **Notes** tab: read-only topics with revision history |
| See what is on staging | **Staging** tab: recent integrations by service, branch, worker and time, across workstreams |
| Drop a task | **Drop** on the board row. The dialog shows uncommitted or unpushed work first. Archives the worker thread and marks the task `dropped` |
| Review what Ariadne has learned | **Lessons** list on the Ariadne page, with **Remove** |
| Glance at everything | Home page section: each workstream with counts of running, blocked and in-review tasks |
| Retire a workstream | **Archive** on the workstream page. Archives the Ariadne thread and its workers. Archiving or deleting the Ariadne thread in BB also archives the workstream; the heartbeat catches deletes the plugin missed |
| Delete a workstream | The trash icon left of **Open Ariadne** on each workstream row (active or archived) and on the workstream page, or `bb ariadne delete <name> --yes`. The dialog lists what happens and shows uncommitted or unpushed work first. Archives live workers through the usual worktree retirement (branches with unpushed commits are kept), deletes the Ariadne thread and its child threads (archives it if BB refuses), then removes the workstream's tasks, notes and audit events. The staging log is kept because deleting does not undo what is on staging. Repeating a delete, or deleting after the thread is gone, succeeds |

Data reaches the UI through plugin RPC, and a realtime signal refreshes open
views when the board, notes or staging log change.

A workstream page's route is the Ariadne panel plus the workstream name as
`subPath`. BB encodes the name in the URL and hands the page the encoded
remainder, so the page decodes it once. Names with spaces or other special
characters open the right page. An unknown name shows "No workstream named …",
and a workstream with no tasks, notes or staging entries shows an empty state
in each tab.

Later, if useful: a status chip in the Ariadne thread header
(`experimental_threadHeaderAction`) and `#task` mentions in the composer
(`bb.ui.registerMentionProvider`).

## CLI

For agents and scripting.

```
bb ariadne create <workstream> [--project <id>] [--link <url>]...
bb ariadne list                      # workstreams and their Ariadne threads
bb ariadne board <workstream>        # same rows as ariadne_board
bb ariadne notes <workstream> [topic]
bb ariadne staging [--limit <n>]
```

## Out of scope for v0

- Editing notes in the UI. Notes are machine-maintained; the UI is read-only.
- Enforcing anything through the `message.dispatch` hook. It is experimental.
- Multi-machine correctness. The plugin assumes the server and workers share
  a host.
- Teammates' staging changes. The log covers only Ariadne workers.

## Open questions

1. Is a 30-minute idle threshold right for "stuck worker"?
2. What does BB do with a rejected `child-completed`? The hook docs say a
   rejected dispatch shows its message to the user and returns 409 to the
   caller. The caller here is BB's own notifier, so it is unverified whether
   the message shows anywhere, whether BB retries, or whether it marks the
   worker. If it surfaces as noise, switch to a different channel (see the
   README findings).
3. Turn tracking lives in memory. After a plugin reload the first completion
   per worker goes through as before, so Ariadne may see one duplicate.
4. The hook treats a worker turn as user-started when it has
   `initiator: user`, no sender and no `origin`. The logs confirm the first
   two for a message typed in the worker thread; `origin` comes from the SDK
   docs. If the app sets an `origin`, those completions go through as before.
