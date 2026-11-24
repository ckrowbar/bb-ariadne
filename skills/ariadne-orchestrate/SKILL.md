---
name: ariadne-orchestrate
description: Turn the current BB thread into an Ariadne orchestrator manager thread when the user asks to become Ariadne, turn this thread into an Ariadne thread, or orchestrate a workstream from here.
---

# Turn this thread into an Ariadne manager thread

Use this skill only when the user explicitly asks to turn the current thread
into an Ariadne thread or start orchestrating a workstream from this thread.

## Steps

1. Pick a short, descriptive workstream name if the user did not specify one
   (lowercase slug, e.g. `auth-refactor`).
2. Run:

```bash
bb ariadne adopt [workstream-name] [--link <url>...] [--continue "<immediate next orchestration request>"]
```

- Pass `--continue` whenever the user also asked you to start orchestrating work
  right away (for example, splitting a plan into worker tasks, adopting threads,
  or checking a board). Omit `--continue` if they only asked to convert the
  thread and wait.
- Pass `--no-pin` only if the user explicitly asked not to pin the thread.
- Any normal child threads already nested under this thread are adopted
  automatically as tracked Ariadne worker subthreads.

3. Immediately reply in one short sentence confirming the workstream name and
   end your turn. Once your turn goes idle, Ariadne reloads this session's
   runtime cleanly (preserving the full conversation) so all `ariadne_*` tools
   and manager instructions become active. If you passed `--continue`, Ariadne
   automatically starts your first manager turn right after reload.
