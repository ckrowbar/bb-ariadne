// Plugin-owned SQLite state: workstreams, notes, tasks, staging log, audit
// events, pending branch cleanup and heartbeat dedupe. better-sqlite3 is
// synchronous, which lets configure() read workstream details inline.
import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TaskStatus } from "./constants";
import type { Note, PrSummary, StagingEntry, Task } from "./contract";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

export interface WorkstreamRow {
  name: string;
  ariadne_thread_id: string;
  project_id: string;
  links_json: string;
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
  created_at: number;
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
  // Retired: lessons moved to BB memory. Kept so migration indexes stay stable;
  // a later migration can drop the table.
  `CREATE TABLE lessons (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     text TEXT NOT NULL,
     source_thread_id TEXT,
     created_at INTEGER NOT NULL)`,
];

function parseLinks(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    workstream: row.workstream,
    title: row.title,
    links: parseLinks(row.links_json),
    workerThreadId: row.worker_thread_id,
    environmentId: row.environment_id,
    branch: row.branch,
    status: row.status,
    prUrl: row.pr_url,
    pr: row.pr_json === null ? null : (JSON.parse(row.pr_json) as PrSummary),
    summary: row.summary,
    harvested: row.harvested === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function openStore(bb: BbPluginApi) {
  const db: Database = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);

  return {
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
    insertWorkstream(name: string, ariadneThreadId: string, projectId: string, links: string[]) {
      db.prepare(
        "INSERT INTO workstreams (name, ariadne_thread_id, project_id, links_json, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(name, ariadneThreadId, projectId, JSON.stringify(links), Date.now());
    },
    archiveWorkstream(name: string) {
      db.prepare("UPDATE workstreams SET archived_at = ? WHERE name = ? AND archived_at IS NULL").run(Date.now(), name);
    },
    unarchiveWorkstream(name: string) {
      db.prepare("UPDATE workstreams SET archived_at = NULL WHERE name = ?").run(name);
    },
    /**
     * Removes a workstream and everything scoped to it. The staging log stays:
     * it records what is on shared staging, which deleting does not undo.
     * Pending branch cleanups stay so worker branches are still tidied.
     */
    deleteWorkstream(name: string) {
      db.transaction(() => {
        const tasks = db.prepare("SELECT id FROM tasks WHERE workstream = ?").all(name) as { id: string }[];
        const digest = db.prepare("DELETE FROM digest_state WHERE key IN (?, ?, ?)");
        for (const { id } of tasks) digest.run(`pr:${id}`, `stuck:${id}`, `harvest:${id}`);
        for (const table of ["tasks", "notes", "note_revisions", "events"]) {
          db.prepare(`DELETE FROM ${table} WHERE workstream = ?`).run(name);
        }
        db.prepare("DELETE FROM workstreams WHERE name = ?").run(name);
      })();
    },
    links(row: WorkstreamRow): string[] {
      return parseLinks(row.links_json);
    },

    // Tasks
    insertTask(input: {
      workstream: string;
      title: string;
      links: string[];
      workerThreadId: string;
      environmentId: string | null;
    }): Task {
      const id = `t_${randomUUID().slice(0, 8)}`;
      const now = Date.now();
      db.prepare(
        `INSERT INTO tasks (id, workstream, title, links_json, worker_thread_id, environment_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
      ).run(id, input.workstream, input.title, JSON.stringify(input.links), input.workerThreadId, input.environmentId, now, now);
      return this.task(id)!;
    },
    task(id: string): Task | undefined {
      const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
      return row === undefined ? undefined : toTask(row);
    },
    taskByWorker(threadId: string): Task | undefined {
      const row = db.prepare("SELECT * FROM tasks WHERE worker_thread_id = ?").get(threadId) as TaskRow | undefined;
      return row === undefined ? undefined : toTask(row);
    },
    tasks(workstream: string, status?: TaskStatus): Task[] {
      const rows = (
        status === undefined
          ? db.prepare("SELECT * FROM tasks WHERE workstream = ? ORDER BY updated_at DESC").all(workstream)
          : db.prepare("SELECT * FROM tasks WHERE workstream = ? AND status = ? ORDER BY updated_at DESC").all(workstream, status)
      ) as TaskRow[];
      return rows.map(toTask);
    },
    activeTasks(): Task[] {
      const rows = db
        .prepare("SELECT * FROM tasks WHERE status IN ('running', 'blocked', 'in-review') ORDER BY updated_at DESC")
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
        status: TaskStatus;
        prUrl: string | null;
        pr: PrSummary | null;
        summary: string | null;
        harvested: boolean;
        branch: string | null;
        environmentId: string | null;
      }>,
    ): Task | undefined {
      const columns: Record<string, unknown> = {};
      if (changes.status !== undefined) columns.status = changes.status;
      if (changes.prUrl !== undefined) columns.pr_url = changes.prUrl;
      if (changes.pr !== undefined) columns.pr_json = changes.pr === null ? null : JSON.stringify(changes.pr);
      if (changes.summary !== undefined) columns.summary = changes.summary;
      if (changes.harvested !== undefined) columns.harvested = changes.harvested ? 1 : 0;
      if (changes.branch !== undefined) columns.branch = changes.branch;
      if (changes.environmentId !== undefined) columns.environment_id = changes.environmentId;
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
    counts(workstream: string) {
      const rows = db
        .prepare("SELECT status, COUNT(*) AS n FROM tasks WHERE workstream = ? GROUP BY status")
        .all(workstream) as { status: TaskStatus; n: number }[];
      const by = Object.fromEntries(rows.map((r) => [r.status, r.n])) as Partial<Record<TaskStatus, number>>;
      return { running: by.running ?? 0, blocked: by.blocked ?? 0, inReview: by["in-review"] ?? 0, done: by.done ?? 0 };
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

    // Heartbeat dedupe: returns true when the signature for key changed.
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
  };
}

export type Store = ReturnType<typeof openStore>;
