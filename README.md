# bb-plugin-cyril

Cyril is a manager agent for BB. Each Cyril thread owns one workstream: it
keeps the workstream's knowledge, spawns and steers worker threads, and is the
main thread the user talks to.

Design: [docs/v0-spec.md](docs/v0-spec.md).

## Use it

Everything you need is in the BB app:

- **Cyril** in the sidebar: create a workstream, open its Cyril thread, and
  see each workstream's board, notes and staging log. Lessons Cyril has
  learned are listed there too.
- **Cyril board** in a thread's panel launcher: the board beside the chat.
- The home page lists active workstreams with task counts.

Hand Cyril tickets in its pinned thread. Ask it to fix or improve itself when
something is off; code changes arrive as draft PRs in this repo, and Cyril
applies them after you merge and ask.

## Install

```
npm ci
bb plugin install . --yes
bb plugin config cyril set pluginProjectId <BB project id of this repo>
bb plugin config cyril set branchConvention '<user>/<TICKET>/<short-slug>'
bb plugin reload cyril
```

Run `bb plugin config cyril` for all settings. The `bb cyril` CLI exists for
agents and scripts.

## Spike findings (2026-10-15)

Test: Cyril (Claude Code) spawned one Haiku worker that listed its `cyril_*`
tools, called `cyril_report`, and finished.

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
   the worker saw only `cyril_report` (as `mcp__bb-bridge__cyril_report` on
   Claude Code), and Cyril saw only `cyril_spawn_worker`. Injected
   instructions took effect.
4. **`threads.send({ mode: "auto" })` wakes an idle Cyril** (`delivery: "sent"`).
   Messages that arrive during a turn steer into it, so the two completion
   notices were handled in one turn.

### Decisions

- Spawn workers as real children and rely on BB's `child-completed`
  notification. Drop the plugin's idle forwarding.
- Keep explicit worker reports (`cyril_report`) for mid-turn events that BB
  cannot see, such as a PR opening or a blocker. Always pass `senderThreadId`.
