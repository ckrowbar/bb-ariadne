// Plugin-owned SQLite state: workstreams, notes, tasks (with dependencies,
// handoff and reaction budgets), run history, durable watches, persistent turn
// tracking, staging log, audit events, pending branch cleanup and dedupe state.
import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type {
  DependsMode,
  RunPhase,
  RunRole,
  RunStatus,
  TaskStatus,
  VerifyMode,
  WatchKind,
  WatchStatus,
} from "./constants.ts";
import type { Note, PrSummary, StagingEntry, Task, TaskRun, Watch } from "./contract.ts";
import { parseExecutionJson, serializeExecutionJson, type ExecutionConfig } from "./execution.ts";
import type { TurnStarter, TurnStateRecord, TurnStateStore } from "./notifications.ts";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

export interface WorkstreamRow {
  name: string;
  ariadne_thread_id: string;
  project_id: string;
  links_json: string;
  ariadne_execution_json: string | null;
  worker_execution_json: string | null;
  archived_at: number | null;
  created_at: number;
}

interface TaskRow {
  id: string;
  workstream: string;
  title: string;
  links_json: string;
  worker_thread_id: string | null;
  environment_id: string | null;
  branch: string | null;
  status: TaskStatus;
  pr_url: string | null;
  pr_json: string | null;
  summary: string | null;
  harvested: number;
  prompt: string | null;
  base_branch: string | null;
  project_id: string | null;
  execution_json: string | null;
  depends_on_json: string;
  depends_mode: DependsMode;
  verify_mode: VerifyMode;
  handoff: string | null;
  reaction_counts_json: string;
  context_tokens: number | null;
  created_at: number;
  updated_at: number;
}

interface TaskRunRow {
  id: number;
  task_id: string;
  workstream: string;
  run_number: number;
  role: RunRole;
  phase: RunPhase;
  thread_id: string;
  status: RunStatus;
  summary: string | null;
  context_tokens: number | null;
  started_at: number;
  ended_at: number | null;
}

interface WatchRow {
  id: string;
  workstream: string;
  task_id: string;
  kind: WatchKind;
  target: string;
  resume_prompt: string;
  status: WatchStatus;
  last_checked_at: number | null;
  last_state: string | null;
  expires_at: number | null;
  created_at: number;
  triggered_at: number | null;
}

interface TurnStateRow {
  worker_thread_id: string;
  started_by: TurnStarter | null;
  reported: number;
  flagged_streak: "user" | "background" | null;
  updated_at: number;
}

export interface BranchCleanupRow {
  environment_id: string;
  repo_path: string;
  branch: string;
  base_ref: string;
  attempts: number;
}

const MIGRATIONS = [
  `CREATE TABLE workstreams (
     name TEXT PRIMARY KEY,
     ariadne_thread_id TEXT NOT NULL UNIQUE,
     project_id TEXT NOT NULL,
     links_json TEXT NOT NULL DEFAULT '[]',
     archived_at INTEGER,
     created_at INTEGER NOT NULL)`,
  `CREATE TABLE notes (
     workstream TEXT NOT NULL,
     topic TEXT NOT NULL,
     body TEXT NOT NULL,
     revision INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (workstream, topic))`,
  `CREATE TABLE note_revisions (
     workstream TEXT NOT NULL,
     topic TEXT NOT NULL,
     revision INTEGER NOT NULL,
     body TEXT NOT NULL,
     written_by TEXT,
     written_at INTEGER NOT NULL,
     PRIMARY KEY (workstream, topic, revision))`,
  `CREATE TABLE tasks (
     id TEXT PRIMARY KEY,
     workstream TEXT NOT NULL,
     title TEXT NOT NULL,
     links_json TEXT NOT NULL DEFAULT '[]',
     worker_thread_id TEXT UNIQUE,
     environment_id TEXT,
     branch TEXT,
     status TEXT NOT NULL,
     pr_url TEXT,
     pr_json TEXT,
     summary TEXT,
     harvested INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL)`,
  `CREATE TABLE staging_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at INTEGER NOT NULL,
     workstream TEXT NOT NULL,
     worker_thread_id TEXT NOT NULL,
     task_id TEXT,
     service TEXT NOT NULL,
     branch TEXT NOT NULL,
     purpose TEXT NOT NULL)`,
  `CREATE TABLE events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at INTEGER NOT NULL,
     workstream TEXT,
     task_id TEXT,
     kind TEXT NOT NULL,
     detail TEXT NOT NULL)`,
  `CREATE TABLE branch_cleanup (
     environment_id TEXT PRIMARY KEY,
     repo_path TEXT NOT NULL,
     branch TEXT NOT NULL,
     base_ref TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     requested_at INTEGER NOT NULL)`,
  `CREATE TABLE digest_state (
     key TEXT PRIMARY KEY,
     signature TEXT NOT NULL,
     updated_at INTEGER NOT NULL)`,
  // Retired: lessons moved to BB memory. Kept so migration indexes stay stable.
  `CREATE TABLE lessons (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     text TEXT NOT NULL,
     source_thread_id TEXT,
     created_at INTEGER NOT NULL)`,
  `ALTER TABLE workstreams ADD COLUMN ariadne_execution_json TEXT`,
  `ALTER TABLE workstreams ADD COLUMN worker_execution_json TEXT`,
  // v2 orchestrator migrations (append-only after index 10)
  `ALTER TABLE tasks ADD COLUMN prompt TEXT`,
  `ALTER TABLE tasks ADD COLUMN base_branch TEXT`,
  `ALTER TABLE tasks ADD COLUMN project_id TEXT`,
  `ALTER TABLE tasks ADD COLUMN execution_json TEXT`,
  `ALTER TABLE tasks ADD COLUMN depends_on_json TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE tasks ADD COLUMN depends_mode TEXT NOT NULL DEFAULT 'done'`,
  `ALTER TABLE tasks ADD COLUMN verify_mode TEXT NOT NULL DEFAULT 'auto'`,
  `ALTER TABLE tasks ADD COLUMN handoff TEXT`,
  `ALTER TABLE tasks ADD COLUMN reaction_counts_json TEXT NOT NULL DEFAULT '{}'`,
  `ALTER TABLE tasks ADD COLUMN context_tokens INTEGER`,
  `CREATE TABLE task_runs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     task_id TEXT NOT NULL,
     workstream TEXT NOT NULL,
     run_number INTEGER NOT NULL,
     role TEXT NOT NULL,
     phase TEXT NOT NULL,
     thread_id TEXT NOT NULL UNIQUE,
     status TEXT NOT NULL,
     summary TEXT,
     context_tokens INTEGER,
     started_at INTEGER NOT NULL,
     ended_at INTEGER)`,
  `CREATE TABLE watches (
     id TEXT PRIMARY KEY,
     workstream TEXT NOT NULL,
     task_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     target TEXT NOT NULL,
     resume_prompt TEXT NOT NULL,
     status TEXT NOT NULL,
     last_checked_at INTEGER,
     last_state TEXT,
     expires_at INTEGER,
     created_at INTEGER NOT NULL,
     triggered_at INTEGER)`,
  `CREATE TABLE turn_state (
     worker_thread_id TEXT PRIMARY KEY,
     started_by TEXT,
     reported INTEGER NOT NULL DEFAULT 0,
     flagged_streak TEXT,
     updated_at INTEGER NOT NULL)`,
];

function parseStringArray(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function parseReactionCounts(json: string | null | undefined): Record<string, number> {
  if (!json) return {};
  try {
    const value: unknown = JSON.parse(json);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    workstream: row.workstream,
    title: row.title,
    links: parseStringArray(row.links_json),
    workerThreadId: row.worker_thread_id,
    environmentId: row.environment_id,
    branch: row.branch,
    status: row.status,
    prUrl: row.pr_url,
    pr: row.pr_json === null ? null : (JSON.parse(row.pr_json) as PrSummary),
    summary: row.summary,
    harvested: row.harvested === 1,
    prompt: row.prompt ?? null,
    baseBranch: row.base_branch ?? null,
    projectId: row.project_id ?? null,
    execution: parseExecutionJson(row.execution_json),
    dependsOn: parseStringArray(row.depends_on_json),
    dependsMode: row.depends_mode === "pr-opened" ? "pr-opened" : "done",
    verifyMode: row.verify_mode === "always" || row.verify_mode === "off" ? row.verify_mode : "auto",
    handoff: row.handoff ?? null,
    reactionCounts: parseReactionCounts(row.reaction_counts_json),
    contextTokens: row.context_tokens ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRun(row: TaskRunRow): TaskRun {
  return {
    id: row.id,
    taskId: row.task_id,
    workstream: row.workstream,
    runNumber: row.run_number,
    role: row.role,
    phase: row.phase,
    threadId: row.thread_id,
    status: row.status,
    summary: row.summary,
    contextTokens: row.context_tokens,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

function toWatch(row: WatchRow): Watch {
  return {
    id: row.id,
    workstream: row.workstream,
    taskId: row.task_id,
    kind: row.kind,
    target: row.target,
    resumePrompt: row.resume_prompt,
    status: row.status,
    lastCheckedAt: row.last_checked_at,
    lastState: row.last_state,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    triggeredAt: row.triggered_at,
  };
}

export function openStore(bb: BbPluginApi) {
  const db: Database = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);

  const turnStateStore: TurnStateStore = {
    get(workerThreadId: string): TurnStateRecord | undefined {
      const row = db.prepare("SELECT * FROM turn_state WHERE worker_thread_id = ?").get(workerThreadId) as
        | TurnStateRow
        | undefined;
      if (row === undefined) return undefined;
      return {
        startedBy: row.started_by,
        reported: row.reported === 1,
        flaggedStreak: row.flagged_streak,
      };
    },
    set(workerThreadId: string, record: TurnStateRecord) {
      db.prepare(
        `INSERT INTO turn_state (worker_thread_id, started_by, reported, flagged_streak, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (worker_thread_id) DO UPDATE SET
           started_by = excluded.started_by,
           reported = excluded.reported,
           flagged_streak = excluded.flagged_streak,
           updated_at = excluded.updated_at`,
      ).run(workerThreadId, record.startedBy, record.reported ? 1 : 0, record.flaggedStreak, Date.now());
    },
    delete(workerThreadId: string) {
      db.prepare("DELETE FROM turn_state WHERE worker_thread_id = ?").run(workerThreadId);
    },
  };

  return {
    turnState: turnStateStore,

    // Workstreams
    workstream(name: string): WorkstreamRow | undefined {
      return db.prepare("SELECT * FROM workstreams WHERE name = ?").get(name) as WorkstreamRow | undefined;
    },
    workstreamByAriadne(threadId: string): WorkstreamRow | undefined {
      return db.prepare("SELECT * FROM workstreams WHERE ariadne_thread_id = ?").get(threadId) as
        | WorkstreamRow
        | undefined;
    },
    workstreams(): WorkstreamRow[] {
      return db.prepare("SELECT * FROM workstreams ORDER BY archived_at IS NOT NULL, created_at DESC").all() as WorkstreamRow[];
    },
    insertWorkstream(
      name: string,
      ariadneThreadId: string,
      projectId: string,
      links: string[],
      execution?: { ariadne?: Partial<ExecutionConfig> | null; worker?: Partial<ExecutionConfig> | null },
    ) {
      db.prepare(
        `INSERT INTO workstreams (name, ariadne_thread_id, project_id, links_json, ariadne_execution_json, worker_execution_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        name,
        ariadneThreadId,
        projectId,
        JSON.stringify(links),
        serializeExecutionJson(execution?.ariadne),
        serializeExecutionJson(execution?.worker),
        Date.now(),
      );
    },
    archiveWorkstream(name: string) {
      db.prepare("UPDATE workstreams SET archived_at = ? WHERE name = ? AND archived_at IS NULL").run(Date.now(), name);
    },
    unarchiveWorkstream(name: string) {
      db.prepare("UPDATE workstreams SET archived_at = NULL WHERE name = ?").run(name);
    },
    updateWorkstream(
      name: string,
      changes: Partial<{
        links: string[];
        ariadneExecution: Partial<ExecutionConfig> | null;
        workerExecution: Partial<ExecutionConfig> | null;
      }>,
    ): WorkstreamRow | undefined {
      const columns: Record<string, unknown> = {};
      if (changes.links !== undefined) columns.links_json = JSON.stringify(changes.links);
      if (changes.ariadneExecution !== undefined) {
        columns.ariadne_execution_json = serializeExecutionJson(changes.ariadneExecution);
      }
      if (changes.workerExecution !== undefined) {
        columns.worker_execution_json = serializeExecutionJson(changes.workerExecution);
      }
      const keys = Object.keys(columns);
      if (keys.length > 0) {
        const assignments = keys.map((key) => `${key} = @${key}`).join(", ");
        db.prepare(`UPDATE workstreams SET ${assignments} WHERE name = @name`).run({ ...columns, name });
      }
      return this.workstream(name);
    },
    /**
     * Removes a workstream and everything scoped to it. The staging log stays:
     * it records what is on shared staging, which deleting does not undo.
     * Pending branch cleanups stay so worker branches are still tidied.
     */
    deleteWorkstream(name: string) {
      db.transaction(() => {
        const tasks = db.prepare("SELECT id, worker_thread_id FROM tasks WHERE workstream = ?").all(name) as {
          id: string;
          worker_thread_id: string | null;
        }[];
        const runThreads = db.prepare("SELECT thread_id FROM task_runs WHERE workstream = ?").all(name) as {
          thread_id: string;
        }[];
        const delDigest = db.prepare("DELETE FROM digest_state WHERE key IN (?, ?, ?, ?, ?)");
        const delTurn = db.prepare("DELETE FROM turn_state WHERE worker_thread_id = ?");
        for (const { id, worker_thread_id } of tasks) {
          delDigest.run(`pr:${id}`, `stuck:${id}`, `harvest:${id}`, `react:${id}`, `dep-drop:${id}`);
          if (worker_thread_id !== null) delTurn.run(worker_thread_id);
        }
        for (const { thread_id } of runThreads) delTurn.run(thread_id);
        for (const table of ["task_runs", "watches", "tasks", "notes", "note_revisions", "events"]) {
          db.prepare(`DELETE FROM ${table} WHERE workstream = ?`).run(name);
        }
        db.prepare("DELETE FROM workstreams WHERE name = ?").run(name);
      })();
    },
    links(row: WorkstreamRow): string[] {
      return parseStringArray(row.links_json);
    },
    ariadneExecution(row: WorkstreamRow): ExecutionConfig {
      return parseExecutionJson(row.ariadne_execution_json);
    },
    workerExecution(row: WorkstreamRow): ExecutionConfig {
      return parseExecutionJson(row.worker_execution_json);
    },

    // Tasks
    insertTask(input: {
      workstream: string;
      title: string;
      links: string[];
      workerThreadId: string | null;
      environmentId: string | null;
      status?: TaskStatus;
      prompt?: string | null;
      baseBranch?: string | null;
      projectId?: string | null;
      execution?: Partial<ExecutionConfig> | null;
      dependsOn?: string[];
      dependsMode?: DependsMode;
      verifyMode?: VerifyMode;
    }): Task {
      const id = `t_${randomUUID().slice(0, 8)}`;
      const now = Date.now();
      const status = input.status ?? (input.workerThreadId === null ? "queued" : "running");
      db.prepare(
        `INSERT INTO tasks (
           id, workstream, title, links_json, worker_thread_id, environment_id, status,
           prompt, base_branch, project_id, execution_json, depends_on_json, depends_mode, verify_mode,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.workstream,
        input.title,
        JSON.stringify(input.links),
        input.workerThreadId,
        input.environmentId,
        status,
        input.prompt ?? null,
        input.baseBranch ?? null,
        input.projectId ?? null,
        serializeExecutionJson(input.execution),
        JSON.stringify(input.dependsOn ?? []),
        input.dependsMode ?? "done",
        input.verifyMode ?? "auto",
        now,
        now,
      );
      return this.task(id)!;
    },
    task(id: string): Task | undefined {
      const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
      return row === undefined ? undefined : toTask(row);
    },
    activeTaskByWorker(threadId: string): Task | undefined {
      const row = db.prepare("SELECT * FROM tasks WHERE worker_thread_id = ?").get(threadId) as TaskRow | undefined;
      return row === undefined ? undefined : toTask(row);
    },
    taskByWorker(threadId: string): Task | undefined {
      const active = this.activeTaskByWorker(threadId);
      if (active !== undefined) return active;
      const run = db.prepare("SELECT task_id FROM task_runs WHERE thread_id = ? ORDER BY started_at DESC LIMIT 1").get(threadId) as
        | { task_id: string }
        | undefined;
      return run === undefined ? undefined : this.task(run.task_id);
    },
    tasks(workstream: string, status?: TaskStatus): Task[] {
      const rows = (
        status === undefined
          ? db.prepare("SELECT * FROM tasks WHERE workstream = ? ORDER BY updated_at DESC").all(workstream)
          : db.prepare("SELECT * FROM tasks WHERE workstream = ? AND status = ? ORDER BY updated_at DESC").all(workstream, status)
      ) as TaskRow[];
      return rows.map(toTask);
    },
    allTasks(): Task[] {
      const rows = db.prepare("SELECT * FROM tasks ORDER BY updated_at DESC").all() as TaskRow[];
      return rows.map(toTask);
    },
    activeTasks(): Task[] {
      const rows = db
        .prepare("SELECT * FROM tasks WHERE status IN ('running', 'verifying', 'waiting', 'blocked', 'in-review') ORDER BY updated_at DESC")
        .all() as TaskRow[];
      return rows.map(toTask);
    },
    unharvestedDone(): Task[] {
      const rows = db.prepare("SELECT * FROM tasks WHERE status = 'done' AND harvested = 0").all() as TaskRow[];
      return rows.map(toTask);
    },
    updateTask(
      id: string,
      changes: Partial<{
        title: string;
        status: TaskStatus;
        workerThreadId: string | null;
        prUrl: string | null;
        pr: PrSummary | null;
        summary: string | null;
        harvested: boolean;
        branch: string | null;
        environmentId: string | null;
        prompt: string | null;
        baseBranch: string | null;
        execution: Partial<ExecutionConfig> | null;
        dependsOn: string[];
        dependsMode: DependsMode;
        verifyMode: VerifyMode;
        handoff: string | null;
        reactionCounts: Record<string, number>;
        contextTokens: number | null;
      }>,
    ): Task | undefined {
      const columns: Record<string, unknown> = {};
      if (changes.title !== undefined) columns.title = changes.title;
      if (changes.status !== undefined) columns.status = changes.status;
      if (changes.workerThreadId !== undefined) columns.worker_thread_id = changes.workerThreadId;
      if (changes.prUrl !== undefined) columns.pr_url = changes.prUrl;
      if (changes.pr !== undefined) columns.pr_json = changes.pr === null ? null : JSON.stringify(changes.pr);
      if (changes.summary !== undefined) columns.summary = changes.summary;
      if (changes.harvested !== undefined) columns.harvested = changes.harvested ? 1 : 0;
      if (changes.branch !== undefined) columns.branch = changes.branch;
      if (changes.environmentId !== undefined) columns.environment_id = changes.environmentId;
      if (changes.prompt !== undefined) columns.prompt = changes.prompt;
      if (changes.baseBranch !== undefined) columns.base_branch = changes.baseBranch;
      if (changes.execution !== undefined) columns.execution_json = serializeExecutionJson(changes.execution);
      if (changes.dependsOn !== undefined) columns.depends_on_json = JSON.stringify(changes.dependsOn);
      if (changes.dependsMode !== undefined) columns.depends_mode = changes.dependsMode;
      if (changes.verifyMode !== undefined) columns.verify_mode = changes.verifyMode;
      if (changes.handoff !== undefined) columns.handoff = changes.handoff;
      if (changes.reactionCounts !== undefined) columns.reaction_counts_json = JSON.stringify(changes.reactionCounts);
      if (changes.contextTokens !== undefined) columns.context_tokens = changes.contextTokens;
      const keys = Object.keys(columns);
      if (keys.length > 0) {
        const assignments = keys.map((key) => `${key} = @${key}`).join(", ");
        db.prepare(`UPDATE tasks SET ${assignments}, updated_at = @updated_at WHERE id = @id`).run({
          ...columns,
          updated_at: Date.now(),
          id,
        });
      }
      return this.task(id);
    },
    bumpReaction(taskId: string, key: string): number {
      const task = this.task(taskId);
      if (task === undefined) return 0;
      const next = { ...task.reactionCounts, [key]: (task.reactionCounts[key] ?? 0) + 1 };
      this.updateTask(taskId, { reactionCounts: next });
      return next[key]!;
    },
    resetReaction(taskId: string, key?: string) {
      const task = this.task(taskId);
      if (task === undefined) return;
      if (key === undefined) {
        this.updateTask(taskId, { reactionCounts: {} });
        return;
      }
      const next = { ...task.reactionCounts };
      delete next[key];
      this.updateTask(taskId, { reactionCounts: next });
    },
    counts(workstream: string) {
      const rows = db
        .prepare("SELECT status, COUNT(*) AS n FROM tasks WHERE workstream = ? GROUP BY status")
        .all(workstream) as { status: TaskStatus; n: number }[];
      const by = Object.fromEntries(rows.map((r) => [r.status, r.n])) as Partial<Record<TaskStatus, number>>;
      return {
        queued: by.queued ?? 0,
        running: by.running ?? 0,
        verifying: by.verifying ?? 0,
        waiting: by.waiting ?? 0,
        blocked: by.blocked ?? 0,
        inReview: by["in-review"] ?? 0,
        done: by.done ?? 0,
      };
    },

    // Runs (ephemeral worker rotations + hidden verifiers)
    insertRun(input: {
      taskId: string;
      workstream: string;
      role: RunRole;
      phase: RunPhase;
      threadId: string;
      status?: RunStatus;
    }): TaskRun {
      const last = db.prepare("SELECT MAX(run_number) AS n FROM task_runs WHERE task_id = ?").get(input.taskId) as {
        n: number | null;
      };
      const runNumber = (last.n ?? 0) + 1;
      const now = Date.now();
      const result = db
        .prepare(
          `INSERT INTO task_runs (task_id, workstream, run_number, role, phase, thread_id, status, started_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(input.taskId, input.workstream, runNumber, input.role, input.phase, input.threadId, input.status ?? "running", now);
      return toRun(db.prepare("SELECT * FROM task_runs WHERE id = ?").get(result.lastInsertRowid) as TaskRunRow);
    },
    runByThread(threadId: string): TaskRun | undefined {
      const row = db.prepare("SELECT * FROM task_runs WHERE thread_id = ?").get(threadId) as TaskRunRow | undefined;
      return row === undefined ? undefined : toRun(row);
    },
    runsForTask(taskId: string): TaskRun[] {
      const rows = db
        .prepare("SELECT * FROM task_runs WHERE task_id = ? ORDER BY run_number ASC, id ASC")
        .all(taskId) as TaskRunRow[];
      return rows.map(toRun);
    },
    runningVerifiers(): TaskRun[] {
      const rows = db
        .prepare("SELECT * FROM task_runs WHERE role = 'verifier' AND status = 'running' ORDER BY started_at ASC")
        .all() as TaskRunRow[];
      return rows.map(toRun);
    },
    updateRunByThread(
      threadId: string,
      changes: Partial<{
        status: RunStatus;
        summary: string | null;
        contextTokens: number | null;
        endedAt: number | null;
      }>,
    ): TaskRun | undefined {
      const columns: Record<string, unknown> = {};
      if (changes.status !== undefined) columns.status = changes.status;
      if (changes.summary !== undefined) columns.summary = changes.summary;
      if (changes.contextTokens !== undefined) columns.context_tokens = changes.contextTokens;
      if (changes.endedAt !== undefined) columns.ended_at = changes.endedAt;
      const keys = Object.keys(columns);
      if (keys.length > 0) {
        const assignments = keys.map((key) => `${key} = @${key}`).join(", ");
        db.prepare(`UPDATE task_runs SET ${assignments} WHERE thread_id = @thread_id`).run({
          ...columns,
          thread_id: threadId,
        });
      }
      return this.runByThread(threadId);
    },

    // Watches (durable zero-token polling)
    insertWatch(input: {
      workstream: string;
      taskId: string;
      kind: WatchKind;
      target: string;
      resumePrompt: string;
      expiresAt: number | null;
    }): Watch {
      const id = `w_${randomUUID().slice(0, 8)}`;
      const now = Date.now();
      db.prepare(
        `INSERT INTO watches (id, workstream, task_id, kind, target, resume_prompt, status, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).run(id, input.workstream, input.taskId, input.kind, input.target, input.resumePrompt, input.expiresAt, now);
      return this.watch(id)!;
    },
    watch(id: string): Watch | undefined {
      const row = db.prepare("SELECT * FROM watches WHERE id = ?").get(id) as WatchRow | undefined;
      return row === undefined ? undefined : toWatch(row);
    },
    activeWatches(workstream?: string): Watch[] {
      const rows = (
        workstream === undefined
          ? db.prepare("SELECT * FROM watches WHERE status = 'active' ORDER BY created_at ASC").all()
          : db.prepare("SELECT * FROM watches WHERE workstream = ? AND status = 'active' ORDER BY created_at ASC").all(workstream)
      ) as WatchRow[];
      return rows.map(toWatch);
    },
    watchesForTask(taskId: string, onlyActive = false): Watch[] {
      const rows = (
        onlyActive
          ? db.prepare("SELECT * FROM watches WHERE task_id = ? AND status = 'active' ORDER BY created_at ASC").all(taskId)
          : db.prepare("SELECT * FROM watches WHERE task_id = ? ORDER BY created_at DESC LIMIT 20").all(taskId)
      ) as WatchRow[];
      return rows.map(toWatch);
    },
    updateWatch(
      id: string,
      changes: Partial<{
        status: WatchStatus;
        lastCheckedAt: number | null;
        lastState: string | null;
        triggeredAt: number | null;
      }>,
    ): Watch | undefined {
      const columns: Record<string, unknown> = {};
      if (changes.status !== undefined) columns.status = changes.status;
      if (changes.lastCheckedAt !== undefined) columns.last_checked_at = changes.lastCheckedAt;
      if (changes.lastState !== undefined) columns.last_state = changes.lastState;
      if (changes.triggeredAt !== undefined) columns.triggered_at = changes.triggeredAt;
      const keys = Object.keys(columns);
      if (keys.length > 0) {
        const assignments = keys.map((key) => `${key} = @${key}`).join(", ");
        db.prepare(`UPDATE watches SET ${assignments} WHERE id = @id`).run({ ...columns, id });
      }
      return this.watch(id);
    },
    cancelWatchesForTask(taskId: string): number {
      const res = db
        .prepare("UPDATE watches SET status = 'cancelled' WHERE task_id = ? AND status = 'active'")
        .run(taskId);
      return Number(res.changes);
    },
    cancelWatchesForWorkstream(workstream: string): number {
      const res = db
        .prepare("UPDATE watches SET status = 'cancelled' WHERE workstream = ? AND status = 'active'")
        .run(workstream);
      return Number(res.changes);
    },

    // Notes: every write keeps the previous body as a revision.
    notes(workstream: string, historyLimit = 5): Note[] {
      const rows = db
        .prepare("SELECT topic, body, revision, updated_at FROM notes WHERE workstream = ? ORDER BY topic")
        .all(workstream) as { topic: string; body: string; revision: number; updated_at: number }[];
      const history = db.prepare(
        "SELECT revision, written_at, body FROM note_revisions WHERE workstream = ? AND topic = ? AND revision < ? ORDER BY revision DESC LIMIT ?",
      );
      return rows.map((row) => ({
        topic: row.topic,
        body: row.body,
        revision: row.revision,
        updatedAt: row.updated_at,
        history: (
          history.all(workstream, row.topic, row.revision, historyLimit) as { revision: number; written_at: number; body: string }[]
        ).map((h) => ({ revision: h.revision, writtenAt: h.written_at, body: h.body })),
      }));
    },
    writeNote(workstream: string, topic: string, body: string, writtenBy: string | null): number {
      const write = db.transaction(() => {
        const current = db.prepare("SELECT revision FROM notes WHERE workstream = ? AND topic = ?").get(workstream, topic) as
          | { revision: number }
          | undefined;
        const revision = (current?.revision ?? 0) + 1;
        const now = Date.now();
        db.prepare(
          `INSERT INTO notes (workstream, topic, body, revision, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (workstream, topic) DO UPDATE SET body = excluded.body, revision = excluded.revision, updated_at = excluded.updated_at`,
        ).run(workstream, topic, body, revision, now);
        db.prepare(
          "INSERT INTO note_revisions (workstream, topic, revision, body, written_by, written_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(workstream, topic, revision, body, writtenBy, now);
        return revision;
      });
      return write();
    },

    // Staging log
    logStaging(entry: Omit<StagingEntry, "id" | "at">): StagingEntry {
      const at = Date.now();
      const result = db
        .prepare(
          "INSERT INTO staging_log (at, workstream, worker_thread_id, task_id, service, branch, purpose) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(at, entry.workstream, entry.workerThreadId, entry.taskId, entry.service, entry.branch, entry.purpose);
      return { ...entry, id: Number(result.lastInsertRowid), at };
    },
    staging(limit: number, sinceMs?: number): StagingEntry[] {
      const rows = db
        .prepare("SELECT * FROM staging_log WHERE at >= ? ORDER BY at DESC LIMIT ?")
        .all(sinceMs ?? 0, limit) as {
        id: number;
        at: number;
        workstream: string;
        worker_thread_id: string;
        task_id: string | null;
        service: string;
        branch: string;
        purpose: string;
      }[];
      return rows.map((r) => ({
        id: r.id,
        at: r.at,
        workstream: r.workstream,
        workerThreadId: r.worker_thread_id,
        taskId: r.task_id,
        service: r.service,
        branch: r.branch,
        purpose: r.purpose,
      }));
    },

    // Audit trail
    event(kind: string, detail: string, workstream: string | null = null, taskId: string | null = null) {
      db.prepare("INSERT INTO events (at, workstream, task_id, kind, detail) VALUES (?, ?, ?, ?, ?)").run(
        Date.now(),
        workstream,
        taskId,
        kind,
        detail.slice(0, 2000),
      );
    },

    // Branch cleanup after worktree teardown
    queueBranchCleanup(row: Omit<BranchCleanupRow, "attempts">) {
      db.prepare(
        `INSERT INTO branch_cleanup (environment_id, repo_path, branch, base_ref, requested_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (environment_id) DO NOTHING`,
      ).run(row.environment_id, row.repo_path, row.branch, row.base_ref, Date.now());
    },
    pendingBranchCleanups(): BranchCleanupRow[] {
      return db.prepare("SELECT * FROM branch_cleanup").all() as BranchCleanupRow[];
    },
    finishBranchCleanup(environmentId: string) {
      db.prepare("DELETE FROM branch_cleanup WHERE environment_id = ?").run(environmentId);
    },
    bumpBranchCleanup(environmentId: string) {
      db.prepare("UPDATE branch_cleanup SET attempts = attempts + 1 WHERE environment_id = ?").run(environmentId);
    },

    // Heartbeat/reconciler dedupe: returns true when the signature for key changed.
    digestChanged(key: string, signature: string): boolean {
      const current = db.prepare("SELECT signature FROM digest_state WHERE key = ?").get(key) as
        | { signature: string }
        | undefined;
      if (current?.signature === signature) return false;
      db.prepare(
        `INSERT INTO digest_state (key, signature, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET signature = excluded.signature, updated_at = excluded.updated_at`,
      ).run(key, signature, Date.now());
      return true;
    },
    clearDigest(key: string) {
      db.prepare("DELETE FROM digest_state WHERE key = ?").run(key);
    },
  };
}

export type Store = ReturnType<typeof openStore>;
