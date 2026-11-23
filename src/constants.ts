// Plain constants shared by server and app. No imports, so app.tsx can use
// them without bundling zod or the server SDK.

export const TASK_STATUSES = ["running", "blocked", "in-review", "done", "dropped"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const REASONING_LEVELS = ["none", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

/** Realtime channel published after any write the UI shows. */
export const CHANGED_CHANNEL = "ariadne-changed";
