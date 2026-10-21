# bb-plugin-ariadne

Ariadne is a manager agent for BB. Each Ariadne thread owns one workstream: it
keeps the workstream's knowledge, spawns and steers worker threads, and is the
main thread the user talks to.

Design: [docs/v0-spec.md](docs/v0-spec.md).

## Use it

Everything you need is in the BB app:

- **Ariadne** in the sidebar: create a workstream, open its Ariadne thread, and
  see each workstream's board, notes and staging log. Lessons Ariadne has
  learned are listed there too.
- **Ariadne board** in a thread's panel launcher: the board beside the chat.
- The home page lists active workstreams with task counts.

Hand Ariadne tickets in its pinned thread. Ask it to fix or improve itself when
something is off; code changes arrive as draft PRs in this repo, and Ariadne
applies them after you merge and ask.

## Install

```
npm ci
bb plugin install . --yes
bb plugin config ariadne set pluginProjectId <BB project id of this repo>
bb plugin config ariadne set branchConvention '<user>/<TICKET>/<short-slug>'
bb plugin reload ariadne
```

Run `bb plugin config ariadne` for all settings. The `bb ariadne` CLI exists for
agents and scripts.

## Spike findings (2026-10-15)

Test: Ariadne (Claude Code) spawned one Haiku worker that listed its `ariadne_*`
tools, called `ariadne_report`, and finished.

1. **Native parent notification.** When a child finishes, BB sends the parent
   a turn with `initiator: system` and `systemMessageKind: child-completed`.
   Its subject is structured
   (`{ kind: "thread", threadId, threadName, outcomes: [{ threadId, status }] }`)
   and its body is `[bb system] @thread:<id> completed: <last output>`. It
   wakes an idle parent. The guide says failures and interruptions notify too;
   the spike did not test those.
2. **Plugin forwarding duplicates it.** With workers linked as children, the
   plugin's idle forward and BB's `child-completed` carried the same text.
   Plugin sends without `senderThreadId` also showed up as `initiator: user`,
   so they looked like messages from the user.
3. **Per-role tools work.** `configure()` reads `context.pluginMetadata`, so
   the worker saw only `ariadne_report` (as `mcp__bb-bridge__ariadne_report` on
   Claude Code), and Ariadne saw only `ariadne_spawn_worker`. Injected
   instructions took effect.
4. **`threads.send({ mode: "auto" })` wakes an idle Ariadne** (`delivery: "sent"`).
   Messages that arrive during a turn steer into it, so the two completion
   notices were handled in one turn.

### Decisions

- Spawn workers as real children and rely on BB's `child-completed`
  notification. Drop the plugin's idle forwarding.
- Keep explicit worker reports (`ariadne_report`) for mid-turn events that BB
  cannot see, such as a PR opening or a blocker. Always pass `senderThreadId`.

## Duplicate completion findings (2026-10-21)

Worker thr_95a8u33hn7 sent Ariadne a `pr-opened` report, a `done` report, a
`child-completed` that repeated the `done` report, and a second
`child-completed` that answered a question the user typed in the worker
thread. Ariadne replied to each.

1. **No spawn or thread setting turns the notice off.** The spawn request has
   `parentThreadId` and `lifecycleOwnerThreadId`, but nothing about
   notifications. Dropping `parentThreadId` would stop the notice entirely,
   and with it BB's failure and interruption notices.
2. **The `message.dispatch` hook sees the notice.** It arrives with
   `initiator: system`, no `senderThreadId`, and text
   `[bb system] @thread:<id> completed:`. The hook context has no
   `systemMessageKind`, so the plugin matches the text. The pass runs before
   BB queues anything, so it runs as the worker's turn ends.
3. **The hook also sees who starts a worker turn.** A message the user types
   in the worker thread has `initiator: user`, no sender and no `origin`.
   Ariadne's `bb thread tell` has `initiator: agent` and Ariadne as sender.
   The plugin's spawn prompt also has `initiator: user` and no sender. The
   SDK docs say its `origin` is set (`plugin`) while follow-ups have none;
   this was not observed directly.

The plugin now rejects a completion that repeats a report or answers the
user directly. If rejection turns out noisy, the fallback is to drop the
`done` relay in `ariadne_report` and keep only BB's completion.

## Quieter plugin messages (2026-10-21)

The Ariadne thread showed every heartbeat digest and worker report as a
message bubble, and Ariadne answered each with "Nothing new."

1. **Agent-only input hides a message but still starts a turn.**
   `threads.send` accepts `visibility: "agent-only"` on each input part. BB
   skips input groups with no visible part when it builds the transcript
   (`buildClientUserMessagesForInputGroups` in BB's server bundle), with or
   without `senderThreadId`. BB's own provider retry uses this for its
   "Please continue." turn. All `tellAriadne` messages now use it.
2. **The repeated digest was a draft PR.** The digest skipped only attention
   `none`, so a draft PR (attention `draft`) was reported, and again after
   each flip through `checks_pending`. Draft, checks-pending and queued PRs
   are now quiet.
3. **I found no other quiet channel that wakes Ariadne.** The send schema has no
   message kind or collapsed rendering beyond agent-only. The
   SDK's other levers are `bb.ui` surfaces and thread titles, which do not
   wake Ariadne. Not verified in the UI: whether BB shows anything for a turn
   that ends with no text.
