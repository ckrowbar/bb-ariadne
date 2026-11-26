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
  staging branch, when, and why. Staging is a shared merge branch, so this is a
  log, not a lock.

## How Ariadne knows what to do

| Layer | What | Where |
| --- | --- | --- |
| Standing orders | Role, autonomy, escalation rules, playbooks | Static instructions from `configure()` |
| Memory guidance | Notes versus BB memory | Static text from `contributeInstructions` |
| State | Notes, board, staging log | Plugin SQLite, read through tools |
| Durable knowledge | Architecture, gotchas, conventions, user preferences | BB memory (`bb memory`), injected into every thread by BB's Memory plugin |
| Triggers | User messages, BB `child-completed`, worker reports, heartbeat digests | Arrive as turns on the Ariadne thread |

Board state is read through tools, not injected into instructions. The plugin
docs say "a live provider session keeps the instructions it was constructed
with", so injected state would go stale.

### Playbooks (part of the standing orders)

- **User names a task.** Read the ticket or links (using any installed MCP bridge tools). Check the
  board for overlapping in-flight tasks. Write a kickoff: goal and definition
  of done, context from notes, constraints, siblings in flight. Spawn the
  worker. Tell the user in one line.
- **`child-completed` or a `done` report arrives.** Read the output. Update the
  task. Fold durable facts into notes and mark the task harvested. Summarise
  for the user only what they need to act on. Stay silent when it repeats a
  report, or when the plugin flags the turn as started by the user or by the
  worker's background task (see Events).
- **A worker asks for something** (blocked or not). Check notes and the
  steers already sent. If it is answered, steer the answer again and say
  nothing to the user. Otherwise answer from notes and steer the worker if
  possible, or escalate.
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

Ariadne asks in plain text with numbered options and ends its turn. It never
uses a blocking question tool such as Claude Code's AskUserQuestion: while
the question is pending, BB queues every message to the thread, including
worker reports, completions, digests and the user's own messages, and
Ariadne cannot steer anyone (README, 2026-11-02). It records the user's
decisions in notes so it can answer repeat asks itself.

## Workers and environments

Workers run in BB-managed worktrees of the workstream's git project, based on
`origin/main` unless the kickoff says otherwise. This replaces the manual
habit of workers running `git worktree add` by hand.
It gives:

- isolation that does not depend on each worker remembering to make a worktree
- a branch BB knows about, so `bb.sdk.environments.pullRequest` reports PR
  state, checks and mergeability
- cleanup when the task's thread is archived

Fallback when a task has no repo: a personal workspace.

Workers spawn with `permissionMode: "full"`, matching how autonomous ticket
threads run. Under the default sandbox, a test worker stalled on "Allow network
connection to 127.0.0.1?" after a plain `git` command.

### Worktree test findings (2026-10-15)

- **Base refresh is the blocker.** With the default base or
  `--base-branch origin/main`, BB first runs
  `git fetch --quiet origin +refs/heads/main:refs/remotes/origin/main`. That
  uses SSH, and SSH on remote hosts only works while a laptop forwards its
  agent, so provisioning failed. A local base (`--base-branch main`) skips the
  fetch, but local `main` was 24 hours old.
  - Fix (built, verified): before each spawn, the plugin fetches the base
    branch over token-authenticated HTTPS (via the optional
    `githubTokenCommand` plugin setting, falling back to stored `gh`
    credentials) and passes the resulting commit as the base. BB accepts a
    commit SHA without fetching.
- **Branch names.** BB names the branch `bb/<title-slug>-<thread-id>`. A worker
  can `git branch -m` to the user's convention; BB shows the new name after its
  next status refresh. The plugin records the worktree's current branch on
  each heartbeat (active tasks only), on every `ariadne_report`, and from the
  `branch` argument of `ariadne_staging_log`, so a rename shows up even if the
  task finishes between heartbeats.
- **PR detection works**, including checks (draft state, passed/failed/pending
  counts). BB's GitHub access does not need SSH.
- **Cost.** Large monorepo worktree checkouts take ~1 min to create and ~2 min
  to tear down.
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
  interaction is pending fails, so the worker has to ask again. A pending
  question also queues every other message to that thread, so Ariadne does
  not use it (README, 2026-11-02).

## Data model (plugin SQLite)

```sql
workstreams(name PRIMARY KEY, ariadne_thread_id, project_id, links_json,
            ariadne_execution_json, worker_execution_json, archived_at, created_at)
notes(workstream, topic, body, revision, updated_at, PRIMARY KEY (workstream, topic))
note_revisions(workstream, topic, revision, body, written_by_thread_id, written_at)
tasks(id PRIMARY KEY, workstream, title, links_json, worker_thread_id,
      environment_id, branch, status, pr_url, pr_json, summary, harvested,
      prompt, base_branch, project_id, execution_json, depends_on_json,
      depends_mode, verify_mode, handoff, reaction_counts_json, context_tokens,
      created_at, updated_at)
task_runs(id PRIMARY KEY, task_id, workstream, run_number, role, phase,
          thread_id, status, summary, context_tokens, started_at, ended_at)
watches(id PRIMARY KEY, workstream, task_id, kind, target, resume_prompt,
        status, last_checked_at, last_state, expires_at, created_at, triggered_at)
turn_state(worker_thread_id PRIMARY KEY, started_by, reported, flagged_streak, updated_at)
staging_log(id PRIMARY KEY, at, worker_thread_id, task_id, service, branch, purpose)
events(id PRIMARY KEY, at, workstream, task_id, kind, detail)  -- audit trail
lessons(id PRIMARY KEY, text, source_thread_id, created_at)    -- retired, unused
branch_cleanup(environment_id PRIMARY KEY, repo_path, branch, base_ref, attempts, requested_at)
digest_state(key PRIMARY KEY, signature, updated_at)          -- reconciler dedupe
```

Task `status`: `queued`, `running`, `verifying`, `waiting`, `blocked`, `in-review`, `done`, `dropped`.
Display attention (`needs-you`, `verifying`, `running`, `waiting`, `queued`, `ready-to-merge`, `in-review`, `done`, `dropped`) is derived at read time from durable facts.
Active workers keep `parentThreadId` so BB's native sidebar nesting and cascade archive stay intact. When a task rotates to a fresh worker run (phase transition above `workerRotateTokens`, or manual rotate), the new nested worker attaches to the existing worktree via `environment: { type: "reuse", environmentId }` BEFORE the superseded run is stopped and archived, so BB never retires the worktree.
Clean-context verifiers spawn with `visibility: "hidden"` and no `parentThreadId` on `{ type: "reuse", environmentId }` so they stay out of the sidebar and do not spam Ariadne; past runs and verifiers remain clickable from the task's Run History.

Notes are written only by machines (Ariadne and the plugin). Every write keeps
the previous revision, so a bad update can be rolled back. Notes hold the
workstream's live state: decisions in flight, overview and status, run results.
Suggested topics: `overview`, `status`, `decisions`, `runs`. Durable knowledge
(architecture, gotchas, conventions, how a system works) goes to BB memory with
`bb memory add --scope project`, so workers and other threads see it without
asking Ariadne. Global scope is only for user preferences that apply across
repos. Before archiving or deleting a workstream, Ariadne promotes anything
durable left in its notes to BB memory. Workers save durable, verified
learnings to project memory themselves.

## Agent tools

Selected per role by `configure()` from thread plugin metadata (verified in
the spike).

**Ariadne threads**

| Tool | Does |
| --- | --- |
| `ariadne_spawn_worker(title, prompt, links?, dependsOn?, dependsMode?, verifyMode?, queueOnly?, providerId?, model?, reasoningLevel?, serviceTier?, baseBranch?)` | Creates the task row and spawns a nested child worker, or queues it when dependencies are unfinished or `maxConcurrentWorkers` is reached |
| `ariadne_board(status?)` | Lists this workstream's tasks: status, deps, watches, context tokens, runs, worker, branch, PR and checks state, summary |
| `ariadne_task_update(taskId, status?, prUrl?, summary?, handoff?, harvested?, dependsOn?, dependsMode?, verifyMode?)` | Edits a task (validating dependency acyclicity) |
| `ariadne_steer(taskId, message?, action?, rotate?, model?, reasoningLevel?)` | Steers a worker, rotates to a fresh nested run on the same worktree, switches model/reasoning live, stops, compacts, or dispatches a queued task immediately |
| `ariadne_session(action, ...)` | Controls Ariadne's own session from chat: status, available models, live model/reasoning/title/pin updates, deferred self-compact/clear-context, workstream worker defaults/links, live orchestrator settings, or detaching back to a normal thread |
| `ariadne_adopt_worker(threadId, title?, links?)` / `ariadne_detach_worker(taskId)` | Pulls an existing normal thread into this workstream as a tracked nested worker subthread, or releases a worker subthread back into a normal standalone thread |
| `ariadne_drop_task(taskId, force?)` | Drops a task and archives its worker from chat (refuses if uncommitted/unpushed work exists unless `force=true`) |
| `ariadne_inspect(taskId)` | Reads bounded live facts: thread status, model, pending interactions, context tokens, last output, diff files, runs, watches, PR state |
| `ariadne_verify(taskId, focus?)` | Spawns an independent hidden clean-context verifier on the task's worktree |
| `ariadne_watch(kind, target, resumePrompt, expiresInHours?, taskId?)` / `ariadne_watch_cancel(watchId)` | Registers or cancels a zero-token durable watch (`pr-merged`, `pr-checks`, `task-done`, `timer`, `command`) |
| `ariadne_notes_read(topic?)` / `ariadne_notes_write(topic, body)` | Reads or replaces a note topic |
| `ariadne_staging(limit?)` | Lists recent staging log entries across all workstreams |
| `ariadne_improve(title, problem, evidence?, proposal?)` | Spawns an improvement worker in the plugin repo |

**Worker threads**

| Tool | Does |
| --- | --- |
| `ariadne_report(status, note, prUrl?, handoff?, urgent?)` | `pr-opened`, `blocked`, `fyi` or `done`. `done` triggers the clean-context verifier when enabled; `fyi` logs quietly unless `urgent=true` |
| `ariadne_watch(kind, target, resumePrompt, expiresInHours?)` | Parks the task in `waiting` on a zero-token watch so the worker ends its turn instead of running bash polling loops |
| `ariadne_staging_log(service, branch, purpose)` | Records an integration into staging right after merging or deploying to staging |

**Verifier threads (hidden, read-only)**

| Tool | Does |
| --- | --- |
| `ariadne_verify_verdict(verdict, summary, issues?, checksRun?)` | Settles verification: `pass` advances the task and notifies Ariadne once; `fail` routes findings back to the worker up to `maxVerifyRetries`, then escalates |

Worker instructions explain the protocol and name the Ariadne thread. They do
not list siblings, because instructions go stale; Ariadne puts siblings in the
kickoff prompt.

## Events and reconciler

| Source | Plugin does |
| --- | --- |
| BB `child-completed` | BB delivers it to Ariadne natively (spike finding 1) for every finished worker turn, whoever started it. Active workers keep `parentThreadId` so sidebar nesting and cascade archive stay intact; hidden verifiers omit `parentThreadId` so they do not clutter the sidebar or notify Ariadne directly |
| `message.dispatch` on a worker, `thread.active`, `thread.idle` | Persists turn attribution (`user`, `ariadne`, `orchestrator`, or `background`) in SQLite (`turn_state`) so reload never resets streaks. When a user or background turn ends, warns Ariadne once per streak; `ariadne_watch` replaces background polling loops altogether |
| `thread.failed` on a worker or verifier | If a verifier crashes, marks the run failed and notifies Ariadne; if a worker fails, marks the run failed, flips the task to `blocked`, and notifies Ariadne |
| `interaction.pending` on a worker | Tells Ariadne at once. An autonomous worker stuck on a permission prompt or question is otherwise invisible |
| `thread.archived` on a worker | Ignores superseded runs archived during worker rotation. For the current active worker, marks the task `dropped` if still `running`/`waiting`/`verifying`, warns Ariadne if work is at risk, and queues local branch cleanup |
| `thread.archived` on an Ariadne thread | Marks the workstream archived |

**Reconciler (`bb.background.service("reconciler")`).** A continuous, single-flight
deterministic control loop (default every 60s, plus immediate wake on spawn,
report, watch, verdict, or settings change) that costs zero model tokens while
waiting:

- **Watches:** evaluates active `pr-merged`, `pr-checks`, `task-done`, `timer`,
  and `command` watches; wakes the worker (rotating to a fresh nested run first
  if context is above `workerRotateTokens`) or Ariadne on trigger or expiry
- **Queue & dependencies:** dispatches `queued` tasks in FIFO order once all
  `dependsOn` tasks satisfy `dependsMode` (`done` or `pr-opened`) and active
  slots are below `maxConcurrentWorkers` (`waiting` tasks do not consume slots);
  escalates if a dependency is `dropped`
- **Bounded PR reactions:** auto-steers or rotates workers on failing CI
  (`autoReactCi`), merge conflicts (`autoReactConflicts`), and optionally
  `changes_requested` (`autoReactReviews`) up to `maxReactionRetries` per PR
  event, then escalates to Ariadne. Merged PRs move tasks to `done` and
  re-trigger queue dispatch
- **Context hygiene:** auto-compacts idle Ariadne manager threads above
  `managerCompactTokens`, and rotates heavy workers at phase boundaries above
  `workerRotateTokens`
- **Stuck / harvest / staging / branch cleanup:** flags workers idle in
  `running` past `stuckMinutes`, nudges Ariadne on unharvested completions and
  repeated escalations (including memory, `AGENTS.md`, and workflow review),
  detects same-hour staging overlaps, and drains pending local branch cleanups

## Autonomy and continuous self-improvement

Ariadne defaults to maximum safe autonomy and actively compounds improvements
across four channels:

- **BB Memory (`bb memory add`):** durable preferences, repo quirks, recurring
  failure modes, and team conventions learned from completions or escalations
- **`AGENTS.md` evolution:** when a repo or workspace convention would prevent
  future friction, Ariadne queues a worker to open a draft PR updating the
  target repo's `AGENTS.md`, or proposes a concrete diff in chat for global /
  workspace `AGENTS.md` files (never silently editing outside a PR)
- **Workflow recommendations:** when recurring bottlenecks appear (repeated CI
  loops, slow checks, unclear task sizing, missing scripts, or orchestrator
  tuning), Ariadne surfaces concrete workflow recommendations in chat
- **Plugin code (`ariadne_improve`):** spawns a worker in a managed worktree of
  the plugin repo (`pluginProjectId`) to open a draft PR; nothing applies live
  until the user merges and asks Ariadne to rebuild and reload.

Verified 2026-10-15: a lesson (Haiku for throwaway tasks, since moved to BB
memory) was followed on the next spawn, and an improvement request produced a
draft PR automatically via `ariadne_improve`.

## UI

v0 uses stable plugin slots (`app.slots.navPanel`,
`app.slots.settingsSection`, `app.slots.threadPanelAction`,
`app.slots.homepageSection`) and BB's `experimental_ProviderModelPicker` for
choosing provider, model, reasoning level and service tier. Thread links open
threads through BB navigation.

| Human interaction | Where you click |
| --- | --- |
| Configure default models | **Settings** → **Installed plugins** → **Ariadne** → **Agents**: pick default provider, model, reasoning level and service tier for Ariadne threads and workers (stored in plugin KV; reset to inherit BB defaults) |
| Start a workstream | **Ariadne** sidebar page → **New workstream** (name, project, optional Ariadne and worker model overrides, optional links). Creates a pinned Ariadne thread with those settings and opens it; workers spawned in the workstream inherit its worker selection |
| Talk to Ariadne, hand it a ticket | The pinned Ariadne thread. Plain chat |
| See what is going on | **Ariadne** page → workstream → **Board** tab: one row per task with status, PR and CI badges. Click a row to open the worker thread, or the badge to open the PR |
| Same, without leaving the chat | **Board** thread panel on the Ariadne thread, same rows beside the conversation |
| Answer an escalation | Ariadne asks in chat with numbered options; reply in the Ariadne thread. It does not use the native question UI, because a pending question blocks every other message to Ariadne |
| Unstick a worker waiting on approval | Ariadne's alert links the worker thread. BB's native approve or deny controls are there |
| Check what Ariadne knows | **Notes** tab: read-only topics with revision history |
| See what is on staging | **Staging** tab: recent integrations by service, branch, worker and time, across workstreams |
| Drop a task | **Drop** on the board row. The dialog shows uncommitted or unpushed work first. Archives the worker thread and marks the task `dropped` |
| Review what Ariadne has learned | BB memory (`bb memory catalog`) |
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
  [--provider <id>] [--model <id>] [--reasoning-level <level>] [--service-tier <tier>]
  [--worker-provider <id>] [--worker-model <id>] [--worker-reasoning-level <level>] [--worker-service-tier <tier>]
bb ariadne adopt [workstream] [--thread <id>] [--link <url>...] [--continue <prompt>] [--no-pin]
bb ariadne detach [workstream] [--thread <id>]
bb ariadne adopt-worker <workstream> <threadId> [--title <title>]
bb ariadne detach-worker <taskId>
bb ariadne list                      # workstreams and their Ariadne threads
bb ariadne board <workstream>        # same rows as ariadne_board
bb ariadne notes <workstream> [topic]
bb ariadne staging [--limit <n>]
bb ariadne watches [workstream]      # active durable watches
bb ariadne runs <taskId>             # worker & verifier run history for a task
bb ariadne reconcile                 # run one immediate reconciler cycle
```

## Out of scope for v0

- Editing notes in the UI. Notes are machine-maintained; the UI is read-only.
- Enforcing anything through the `message.dispatch` hook. It is experimental.
- Multi-machine correctness. The plugin assumes the server and workers share
  a host.
- Teammates' staging changes. The log covers only Ariadne workers.

## Open questions

1. Is a 30-minute idle threshold right for "stuck worker"?
2. Should workers stop being BB children? Without `parentThreadId` BB
   sends no completion notices, and the plugin could forward each worker
   turn itself from `thread.idle` and `thread.failed`: labelled, deduped
   against reports, and coalesced. The cost is losing sidebar nesting and
   BB's native failure notices. This would replace the per-streak notes.
3. Turn tracking lives in memory. After a plugin reload the plugin knows
   nothing until each worker's next turn starts.
4. The hook treats a worker turn as user-started when it has
   `initiator: user`, no sender and no `origin`. The logs confirm the first
   two for a message typed in the worker thread; `origin` comes from the SDK
   docs. If the app sets an `origin`, those turns count as Ariadne's.
5. A turn with no recorded start counts as a background wake. That assumes
   BB fires `thread.active` for a background-task wake, which the event log
   suggests (`turn/started` with no `client/turn/requested`) but was not
   observed through the plugin.
