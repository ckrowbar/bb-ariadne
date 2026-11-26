# Ariadne (`bb-plugin-ariadne`)

Ariadne is a [BB](https://getbb.app) plugin that turns a pinned BB thread into an autonomous manager for a full workstream. Talk to one manager thread (`🧶`) instead of babysitting separate coding threads, while Ariadne plans work, runs nested workers (`🧵`) in isolated git worktrees, and handles routine PR follow-ups automatically.

## Why use Ariadne

- **One manager thread, full visibility underneath:** Hand goals or tickets to your pinned Ariadne thread (`🧶`). Workers run as nested child threads (`🧵`) in their own git worktrees, so you can open or message any worker directly from the BB sidebar.
- **Deterministic automation without burning manager tokens:** A background daemon handles dependency queuing, concurrency caps, zero-token watches (PR merges, CI checks, timers, commands at either task or workstream scope), bounded retries for failing CI or merge conflicts, and transient provider error retries on manager turns.
- **Proactive handoffs and draft PR alerts:** When a wave of tasks and watches settles, Ariadne wraps up with status and next options instead of going silent, and alerts you once when a draft PR's checks turn green.
- **Fresh context on long tasks:** When a worker's context fills up, Ariadne rotates to a fresh worker thread reusing the same worktree and branch while carrying forward the task contract and handoff.
- **Clean-context verification before review:** Finished code tasks run through a hidden, read-only verifier (`🔍`) that inspects the diff and runs tests independently, routing real bugs back to the worker before asking you to review.
- **Chat-first control and tidy threads:** Promote any normal BB thread into an Ariadne manager in chat, drag threads into or out of a workstream, rename threads while preserving `🧶`/`🧵` prefixes and synced tab titles, and let Ariadne delete finished or unneeded worker threads while keeping completed task history on the board.
- **Compounds over time:** Ariadne keeps live state in workstream notes, promotes durable facts to BB memory, proposes `AGENTS.md` updates when workers hit repeat friction, and can open draft PRs to improve itself.

## How it works

1. **Start or adopt a workstream** from the **Ariadne** sidebar panel, or tell any existing BB thread to become an Ariadne manager.
2. **Give Ariadne a goal or ticket.** It splits independent or stacked tasks, queues dependencies, and spawns nested workers.
3. **Let the loop run.** Watches trigger follow-ups, CI failures and merge conflicts auto-retry, stale workers rotate cleanly, and finished code passes through a read-only verifier.
4. **Step in only when needed.** Track progress and active watches on the Board tab and answer only genuine judgment calls, merges, or external actions.

## Install

Requires BB `>= 0.45` and Node.js / `npm`.

### Quick install (recommended for most users)

```shell
bb plugin install https://github.com/ckrowbar/bb-ariadne.git --yes
```

### Local checkout install (for editing or self-improvement PRs)

```shell
git clone https://github.com/ckrowbar/bb-ariadne.git
cd bb-ariadne
npm ci
bb plugin install . --yes
```

### Optional configuration

- **Default models:** Open **Settings > Installed plugins > Ariadne > Agents** to set default providers, models, and reasoning levels for managers, workers, and verifiers (or override them per workstream).
- **Plugin settings:** Run `bb plugin config ariadne` to configure a branch naming convention, `pluginProjectId` (for self-improvement PRs), `githubTokenCommand` (optional org-scoped HTTPS GitHub token command), concurrency limits, verification defaults, auto-reactions, or rotation/compaction thresholds, then run `bb plugin reload ariadne`.

### Update

- **Git install:** Run `bb plugin update ariadne`.
- **Local checkout:** Run:
  ```shell
  git pull --ff-only && npm ci && bb plugin build && bb plugin reload ariadne
  ```
- **Reload existing threads:** `bb plugin reload ariadne` updates the daemon and UI immediately, but already-loaded idle Ariadne threads keep their old MCP tool schemas and standing orders until you run `bb thread stop <thread-id>` while idle so their next turn starts a fresh runtime.

## CLI reference

Everything is available in the BB UI (the **Ariadne** sidebar panel, the **Ariadne board** thread panel, and the Home workstream list). The `bb ariadne` CLI is also available for agents and scripts:

```shell
bb ariadne list
bb ariadne create <name>
bb ariadne adopt [name]
bb ariadne detach
bb ariadne board <workstream>
bb ariadne watches [workstream]
bb ariadne runs <taskId>
bb ariadne notes <workstream>
bb ariadne staging
bb ariadne reconcile
bb ariadne delete <workstream>
```

## Development

```shell
npm ci
npm test
npx tsc -p .
bb plugin build
```
