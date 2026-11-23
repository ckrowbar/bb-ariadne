// Types and the RPC contract shared by the server and app.tsx.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { REASONING_LEVELS, TASK_STATUSES } from "./constants";

export { CHANGED_CHANNEL, REASONING_LEVELS, TASK_STATUSES, type ReasoningLevel, type TaskStatus } from "./constants";

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
});
export type PrSummary = z.infer<typeof prSchema>;

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
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Task = z.infer<typeof taskSchema>;

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
    running: z.number(),
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
  board: {
    input: z.object({ workstream: z.string() }),
    output: z.object({ tasks: z.array(taskSchema) }),
  },
  task_drop_preview: {
    input: z.object({ taskId: z.string() }),
    output: z.object({ risk: z.string().nullable() }),
  },
  task_drop: {
    input: z.object({ taskId: z.string() }),
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
      role: z.enum(["ariadne", "worker", "none"]),
      workstream: z.string().nullable(),
      taskId: z.string().nullable(),
    }),
  },
});
