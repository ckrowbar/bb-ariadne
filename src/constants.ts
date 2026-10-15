// Plain constants shared by server and app. No imports, so app.tsx can use
// them without bundling zod or the server SDK.

export const TASK_STATUSES = ["running", "blocked", "in-review", "done", "dropped"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Realtime channel published after any write the UI shows. */
export const CHANGED_CHANNEL = "cyril-changed";
