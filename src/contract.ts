// Types and the RPC contract shared by the server and app.tsx.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  DEPENDS_MODES,
  REASONING_LEVELS,
  RUN_PHASES,
  RUN_ROLES,
  RUN_STATUSES,
  TASK_ATTENTION_LANES,
  TASK_STATUSES,
  VERIFY_MODES,
  WATCH_KINDS,
  WATCH_STATUSES,
} from "./constants.ts";

export {
  CHANGED_CHANNEL,
  DEPENDS_MODES,
  REASONING_LEVELS,
  RUN_PHASES,
  RUN_ROLES,
  RUN_STATUSES,
  TASK_ATTENTION_LANES,
  TASK_STATUSES,
  VERIFY_MODES,
  WATCH_KINDS,
  WATCH_STATUSES,
  type DependsMode,
  type ReasoningLevel,
  type RunPhase,
  type RunRole,
  type RunStatus,
  type TaskAttentionLane,
  type TaskStatus,
  type VerifyMode,
  type WatchKind,
  type WatchStatus,
} from "./constants.ts";

export const executionConfigSchema = z.object({
  providerId: z.string().nullable(),
  model: z.string().nullable(),
  reasoningLevel: z.enum(REASONING_LEVELS).nullable(),
  serviceTier: z.string().nullable(),
});
export type ExecutionConfig = z.infer<typeof executionConfigSchema>;

export const agentDefaultsSchema = z.object({
  ariadne: executionConfigSchema,
  worker: executionConfigSchema,
});
export type AgentDefaults = z.infer<typeof agentDefaultsSchema>;

const prSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  attention: z.string(),
  checks: z.object({
    state: z.string(),
    passed: z.number(),
    failed: z.number(),
    pending: z.number(),
  }),
  updatedAt: z.string().nullable().optional(),
  reviewState: z.string().nullable().optional(),
  mergeableState: z.string().nullable().optional(),
});
export type PrSummary = z.infer<typeof prSchema>;

export const taskRunSchema = z.object({
  id: z.number(),
  taskId: z.string(),
  workstream: z.string(),
  runNumber: z.number(),
  role: z.enum(RUN_ROLES),
  phase: z.enum(RUN_PHASES),
  threadId: z.string(),
  status: z.enum(RUN_STATUSES),
  summary: z.string().nullable(),
  contextTokens: z.number().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
});
export type TaskRun = z.infer<typeof taskRunSchema>;

export const watchSchema = z.object({
  id: z.string(),
  workstream: z.string(),
  taskId: z.string(),
  kind: z.enum(WATCH_KINDS),
  target: z.string(),
  resumePrompt: z.string(),
  status: z.enum(WATCH_STATUSES),
  lastCheckedAt: z.number().nullable(),
  lastState: z.string().nullable(),
  expiresAt: z.number().nullable(),
  createdAt: z.number(),
  triggeredAt: z.number().nullable(),
});
export type Watch = z.infer<typeof watchSchema>;

const taskSchema = z.object({
  id: z.string(),
  workstream: z.string(),
  title: z.string(),
  links: z.array(z.string()),
  workerThreadId: z.string().nullable(),
  environmentId: z.string().nullable(),
  branch: z.string().nullable(),
  status: z.enum(TASK_STATUSES),
  prUrl: z.string().nullable(),
  pr: prSchema.nullable(),
  summary: z.string().nullable(),
  harvested: z.boolean(),
  prompt: z.string().nullable(),
  baseBranch: z.string().nullable(),
  projectId: z.string().nullable(),
  execution: executionConfigSchema,
  dependsOn: z.array(z.string()),
  dependsMode: z.enum(DEPENDS_MODES),
  verifyMode: z.enum(VERIFY_MODES),
  handoff: z.string().nullable(),
  reactionCounts: z.record(z.string(), z.number()),
  contextTokens: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Task = z.infer<typeof taskSchema>;

export const boardTaskSchema = taskSchema.extend({
  attention: z.enum(TASK_ATTENTION_LANES),
  attentionReason: z.string().nullable(),
  runs: z.array(taskRunSchema),
  watches: z.array(watchSchema),
});
export type BoardTask = z.infer<typeof boardTaskSchema>;

const workstreamSchema = z.object({
  name: z.string(),
  ariadneThreadId: z.string(),
  projectId: z.string(),
  projectName: z.string().nullable(),
  links: z.array(z.string()),
  archived: z.boolean(),
  ariadneExecution: executionConfigSchema,
  workerExecution: executionConfigSchema,
  counts: z.object({
    queued: z.number(),
    running: z.number(),
    verifying: z.number(),
    waiting: z.number(),
    blocked: z.number(),
    inReview: z.number(),
    done: z.number(),
  }),
});
export type Workstream = z.infer<typeof workstreamSchema>;

const noteSchema = z.object({
  topic: z.string(),
  body: z.string(),
  revision: z.number(),
  updatedAt: z.number(),
  history: z.array(z.object({ revision: z.number(), writtenAt: z.number(), body: z.string() })),
});
export type Note = z.infer<typeof noteSchema>;

const stagingEntrySchema = z.object({
  id: z.number(),
  at: z.number(),
  workstream: z.string(),
  workerThreadId: z.string(),
  taskId: z.string().nullable(),
  service: z.string(),
  branch: z.string(),
  purpose: z.string(),
});
export type StagingEntry = z.infer<typeof stagingEntrySchema>;

const deletionPreviewSchema = z.object({
  tasks: z.number(),
  notes: z.number(),
  liveWorkers: z.number(),
  risks: z.array(z.object({ taskId: z.string(), title: z.string(), risk: z.string() })),
});
export type DeletionPreview = z.infer<typeof deletionPreviewSchema>;

export const rpcContract = defineRpcContract({
  overview: {
    input: z.null(),
    output: z.object({ workstreams: z.array(workstreamSchema) }),
  },
  projects: {
    input: z.null(),
    output: z.object({
      projects: z.array(z.object({ id: z.string(), name: z.string(), kind: z.string(), hostId: z.string().nullable() })),
    }),
  },
  agent_defaults_get: {
    input: z.null(),
    output: agentDefaultsSchema,
  },
  agent_defaults_set: {
    input: agentDefaultsSchema,
    output: agentDefaultsSchema,
  },
  workstream_create: {
    input: z.object({
      name: z.string().trim().min(1).max(60),
      projectId: z.string(),
      links: z.array(z.string().trim().min(1)).max(20),
      ariadne: executionConfigSchema.optional(),
      worker: executionConfigSchema.optional(),
    }),
    output: z.object({ ariadneThreadId: z.string() }),
  },
  workstream_archive: {
    input: z.object({ name: z.string() }),
    output: z.object({ ok: z.boolean() }),
  },
  workstream_delete_preview: {
    input: z.object({ name: z.string() }),
    output: deletionPreviewSchema,
  },
  workstream_delete: {
    input: z.object({ name: z.string() }),
    output: z.object({ ok: z.boolean(), detail: z.string() }),
  },
  workstream_compact: {
    input: z.object({ name: z.string() }),
    output: z.object({ ok: z.boolean(), detail: z.string() }),
  },
  board: {
    input: z.object({ workstream: z.string() }),
    output: z.object({ tasks: z.array(boardTaskSchema) }),
  },
  task_drop_preview: {
    input: z.object({ taskId: z.string() }),
    output: z.object({ risk: z.string().nullable() }),
  },
  task_drop: {
    input: z.object({ taskId: z.string() }),
    output: z.object({ ok: z.boolean(), detail: z.string() }),
  },
  task_dispatch_now: {
    input: z.object({ taskId: z.string() }),
    output: z.object({ ok: z.boolean(), detail: z.string() }),
  },
  task_rotate: {
    input: z.object({ taskId: z.string(), reason: z.string().max(500).optional() }),
    output: z.object({ ok: z.boolean(), detail: z.string() }),
  },
  task_verify: {
    input: z.object({ taskId: z.string(), focus: z.string().max(1000).optional() }),
    output: z.object({ ok: z.boolean(), detail: z.string() }),
  },
  watch_cancel: {
    input: z.object({ watchId: z.string() }),
    output: z.object({ ok: z.boolean(), detail: z.string() }),
  },
  notes: {
    input: z.object({ workstream: z.string() }),
    output: z.object({ notes: z.array(noteSchema) }),
  },
  staging: {
    input: z.object({ limit: z.number().int().min(1).max(200) }),
    output: z.object({ entries: z.array(stagingEntrySchema) }),
  },
  thread_context: {
    input: z.object({ threadId: z.string() }),
    output: z.object({
      role: z.enum(["ariadne", "worker", "verifier", "none"]),
      workstream: z.string().nullable(),
      taskId: z.string().nullable(),
    }),
  },
});
