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
