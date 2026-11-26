// Plain constants shared by server and app. No imports, so app.tsx can use
// them without bundling zod or the server SDK.

export const TASK_STATUSES = [
  "queued",
  "running",
  "verifying",
  "waiting",
  "blocked",
  "in-review",
  "done",
  "dropped",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_ATTENTION_LANES = [
  "needs-you",
  "verifying",
  "running",
  "waiting",
  "queued",
  "ready-to-merge",
  "in-review",
  "done",
  "dropped",
] as const;
export type TaskAttentionLane = (typeof TASK_ATTENTION_LANES)[number];

export const DEPENDS_MODES = ["done", "pr-opened"] as const;
export type DependsMode = (typeof DEPENDS_MODES)[number];

export const VERIFY_MODES = ["auto", "always", "off"] as const;
export type VerifyMode = (typeof VERIFY_MODES)[number];

export const RUN_ROLES = ["worker", "verifier"] as const;
export type RunRole = (typeof RUN_ROLES)[number];

export const RUN_PHASES = [
  "implement",
  "adopt",
  "fix-ci",
  "rebase",
  "review-feedback",
  "verify",
  "continue",
  "rotate",
] as const;
export type RunPhase = (typeof RUN_PHASES)[number];

export const RUN_STATUSES = ["running", "completed", "failed", "superseded", "passed", "rejected"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const WATCH_KINDS = ["pr-merged", "pr-checks", "task-done", "timer", "command"] as const;
export type WatchKind = (typeof WATCH_KINDS)[number];

export const WATCH_STATUSES = ["active", "triggered", "cancelled", "expired"] as const;
export type WatchStatus = (typeof WATCH_STATUSES)[number];

export const WATCH_OWNERS = ["worker", "ariadne"] as const;
export type WatchOwner = (typeof WATCH_OWNERS)[number];

export const REASONING_LEVELS = ["none", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

/** Realtime channel published after any write the UI shows. */
export const CHANGED_CHANNEL = "ariadne-changed";
