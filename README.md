# bb-plugin-cyril

Cyril is a manager agent for BB. Each Cyril thread owns one workstream: it
keeps the workstream's knowledge, spawns and steers worker threads, and is the
main thread the user talks to.

This repo currently holds a **spike**: throwaway code written to check how BB
behaves before committing to a design.

## Try it

```
bb plugin install . --yes
bb cyril create <workstream> --project <project-id>
bb cyril debug            # every event the plugin observed
```

Cyril threads get the `cyril_spawn_worker` tool. Workers it spawns get the
`cyril_report` tool. Two settings (`bb plugin config cyril`) switch between
spawning workers as child threads and forwarding worker idle/failed events.

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
