import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { openStore } from "./db.ts";

function memoryStore(db = new Database(":memory:")) {
  let applied = 0;
  const bb = {
    storage: {
      database: () => db,
      migrate: (target: Database.Database, statements: string[]) => {
        for (let i = applied; i < statements.length; i++) {
          target.exec(statements[i]!);
          applied = i + 1;
        }
      },
    },
  } as unknown as BbPluginApi;
  return { db, store: openStore(bb) };
}

function seed(store: ReturnType<typeof memoryStore>["store"], name: string, ariadne: string, worker: string) {
  store.insertWorkstream(name, ariadne, "proj", []);
  const task = store.insertTask({ workstream: name, title: `${name} task`, links: [], workerThreadId: worker, environmentId: null });
  store.insertRun({ taskId: task.id, workstream: name, role: "worker", phase: "implement", threadId: worker });
  store.insertWatch({ workstream: name, taskId: task.id, kind: "timer", target: "10m", resumePrompt: "go", expiresAt: null });
  store.turnState.set(worker, { startedBy: "user", reported: false, flaggedStreak: "user" });
  store.writeNote(name, "overview", "body", ariadne);
  store.event("worker-spawned", worker, name, task.id);
  store.digestChanged(`pr:${task.id}`, "open");
  store.logStaging({ workstream: name, workerThreadId: worker, taskId: task.id, service: "svc", branch: "b", purpose: "p" });
  return task;
}

const count = (db: Database.Database, sql: string, ...params: unknown[]) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get(...params) as { n: number }).n;

test("deleting a workstream removes its tasks, runs, watches, turn state and notes while keeping staging log", () => {
  const { db, store } = memoryStore();
  const gone = seed(store, "gone", "thr_a1", "thr_w1");
  const kept = seed(store, "kept", "thr_a2", "thr_w2");

  store.deleteWorkstream("gone");

  assert.equal(store.workstream("gone"), undefined);
  assert.equal(store.task(gone.id), undefined);
  assert.deepEqual(store.notes("gone"), []);
  assert.equal(count(db, "task_runs WHERE workstream = ?", "gone"), 0);
  assert.equal(count(db, "watches WHERE workstream = ?", "gone"), 0);
  assert.equal(count(db, "turn_state WHERE worker_thread_id = ?", "thr_w1"), 0);
  assert.equal(count(db, "note_revisions WHERE workstream = ?", "gone"), 0);
  assert.equal(count(db, "events WHERE workstream = ?", "gone"), 0);
  assert.equal(count(db, "digest_state WHERE key = ?", `pr:${gone.id}`), 0);
  assert.equal(count(db, "staging_log WHERE workstream = ?", "gone"), 1);

  assert.ok(store.workstream("kept"));
  assert.ok(store.task(kept.id));
  assert.equal(count(db, "task_runs WHERE workstream = ?", "kept"), 1);
  assert.equal(count(db, "watches WHERE workstream = ?", "kept"), 1);
  assert.equal(count(db, "turn_state WHERE worker_thread_id = ?", "thr_w2"), 1);
  assert.equal(store.notes("kept").length, 1);
  assert.equal(count(db, "digest_state WHERE key = ?", `pr:${kept.id}`), 1);
});

test("deleting is idempotent and frees the name", () => {
  const { store } = memoryStore();
  seed(store, "again", "thr_a1", "thr_w1");
  store.deleteWorkstream("again");
  store.deleteWorkstream("again");
  store.insertWorkstream("again", "thr_a3", "proj", []);
  assert.equal(store.workstream("again")?.ariadne_thread_id, "thr_a3");
});

test("workstreams store and parse Ariadne and worker execution overrides", () => {
  const { store } = memoryStore();
  store.insertWorkstream("defaults", "thr_a1", "proj", []);
  const defRow = store.workstream("defaults")!;
  assert.equal(defRow.ariadne_execution_json, null);
  assert.equal(defRow.worker_execution_json, null);
  assert.deepEqual(store.ariadneExecution(defRow), {
    providerId: null,
    model: null,
    reasoningLevel: null,
    serviceTier: null,
  });

  store.insertWorkstream("custom", "thr_a2", "proj", [], {
    ariadne: { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high", serviceTier: "fast" },
    worker: { providerId: "codex", model: "gpt-6.2-sol", reasoningLevel: "medium", serviceTier: null },
  });
  const customRow = store.workstream("custom")!;
  assert.deepEqual(store.ariadneExecution(customRow), {
    providerId: "claude-code",
    model: "claude-opus-5-5",
    reasoningLevel: "high",
    serviceTier: "fast",
  });
  assert.deepEqual(store.workerExecution(customRow), {
    providerId: "codex",
    model: "gpt-6.2-sol",
    reasoningLevel: "medium",
    serviceTier: null,
  });
});

test("migrating an existing v0 database preserves existing workstreams, tasks, notes and staging rows", () => {
  const db = new Database(":memory:");
  // Seed exact v0 schema (indexes 0..10).
  const v0Statements = [
    `CREATE TABLE workstreams (name TEXT PRIMARY KEY, ariadne_thread_id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, links_json TEXT NOT NULL DEFAULT '[]', archived_at INTEGER, created_at INTEGER NOT NULL)`,
    `CREATE TABLE notes (workstream TEXT NOT NULL, topic TEXT NOT NULL, body TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (workstream, topic))`,
    `CREATE TABLE note_revisions (workstream TEXT NOT NULL, topic TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, written_by TEXT, written_at INTEGER NOT NULL, PRIMARY KEY (workstream, topic, revision))`,
    `CREATE TABLE tasks (id TEXT PRIMARY KEY, workstream TEXT NOT NULL, title TEXT NOT NULL, links_json TEXT NOT NULL DEFAULT '[]', worker_thread_id TEXT UNIQUE, environment_id TEXT, branch TEXT, status TEXT NOT NULL, pr_url TEXT, pr_json TEXT, summary TEXT, harvested INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE staging_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, workstream TEXT NOT NULL, worker_thread_id TEXT NOT NULL, task_id TEXT, service TEXT NOT NULL, branch TEXT NOT NULL, purpose TEXT NOT NULL)`,
    `CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, workstream TEXT, task_id TEXT, kind TEXT NOT NULL, detail TEXT NOT NULL)`,
    `CREATE TABLE branch_cleanup (environment_id TEXT PRIMARY KEY, repo_path TEXT NOT NULL, branch TEXT NOT NULL, base_ref TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, requested_at INTEGER NOT NULL)`,
    `CREATE TABLE digest_state (key TEXT PRIMARY KEY, signature TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE lessons (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, source_thread_id TEXT, created_at INTEGER NOT NULL)`,
    `ALTER TABLE workstreams ADD COLUMN ariadne_execution_json TEXT`,
    `ALTER TABLE workstreams ADD COLUMN worker_execution_json TEXT`,
  ];
  for (const sql of v0Statements) db.exec(sql);
  db.prepare("INSERT INTO workstreams (name, ariadne_thread_id, project_id, created_at) VALUES ('legacy', 'thr_leg', 'proj_1', 100)").run();
  db.prepare(
    "INSERT INTO tasks (id, workstream, title, worker_thread_id, status, pr_url, created_at, updated_at) VALUES ('t_leg1', 'legacy', 'Existing task', 'thr_wleg', 'in-review', 'https://github.com/o/r/pull/1', 100, 200)",
  ).run();
  db.prepare("INSERT INTO notes (workstream, topic, body, revision, updated_at) VALUES ('legacy', 'decisions', 'keep me', 1, 150)").run();

  const bb = {
    storage: {
      database: () => db,
      migrate: (target: Database.Database, statements: string[]) => {
        for (let i = v0Statements.length; i < statements.length; i++) target.exec(statements[i]!);
      },
    },
  } as unknown as BbPluginApi;

  const store = openStore(bb);
  assert.equal(store.workstream("legacy")?.ariadne_thread_id, "thr_leg");
  const migrated = store.task("t_leg1");
  assert.ok(migrated);
  assert.equal(migrated.status, "in-review");
  assert.deepEqual(migrated.dependsOn, []);
  assert.equal(migrated.dependsMode, "done");
  assert.equal(migrated.verifyMode, "auto");
  assert.deepEqual(migrated.reactionCounts, {});
  assert.equal(store.notes("legacy")[0]?.body, "keep me");

  // New tables work seamlessly on the migrated DB.
  const w = store.insertWatch({ workstream: "legacy", taskId: "t_leg1", kind: "pr-merged", target: "self", resumePrompt: "harvest", expiresAt: null });
  assert.equal(store.activeWatches("legacy").length, 1);
  assert.equal(store.watch(w.id)?.status, "active");
  assert.equal(store.workstreamTitle(store.workstream("legacy")!), "legacy");
});

test("workstream display title defaults to name and updates cleanly", () => {
  const { store } = memoryStore();
  store.insertWorkstream("personal-workstream", "thr_a1", "proj", [], { title: "Slack Storage" });
  const row = store.workstream("personal-workstream")!;
  assert.equal(row.title, "Slack Storage");
  assert.equal(store.workstreamTitle(row), "Slack Storage");

  store.updateWorkstream("personal-workstream", { title: "Cross-DC Rollout" });
  assert.equal(store.workstreamTitle(store.workstream("personal-workstream")!), "Cross-DC Rollout");

  store.updateWorkstream("personal-workstream", { title: "   " });
  assert.equal(store.workstream("personal-workstream")!.title, null);
  assert.equal(store.workstreamTitle(store.workstream("personal-workstream")!), "personal-workstream");
});

test("watches support owner and null taskId for workstream-level manager watches", () => {
  const { store } = memoryStore();
  store.insertWorkstream("ws", "thr_a1", "proj", []);
  const task = store.insertTask({ workstream: "ws", title: "t", links: [], workerThreadId: "thr_w1", environmentId: null });

  const workerWatch = store.insertWatch({
    workstream: "ws",
    taskId: task.id,
    kind: "timer",
    target: "10m",
    resumePrompt: "worker check",
    expiresAt: null,
  });
  assert.equal(workerWatch.owner, "worker");
  assert.equal(workerWatch.taskId, task.id);

  const mgrTaskWatch = store.insertWatch({
    workstream: "ws",
    taskId: task.id,
    owner: "ariadne",
    kind: "pr-checks",
    target: "ddoghq/dd-source#189159",
    resumePrompt: "mark ready",
    expiresAt: null,
  });
  assert.equal(mgrTaskWatch.owner, "ariadne");

  const wsWatch = store.insertWatch({
    workstream: "ws",
    taskId: null,
    owner: "ariadne",
    kind: "timer",
    target: "5m",
    resumePrompt: "follow up",
    expiresAt: null,
  });
  assert.equal(wsWatch.owner, "ariadne");
  assert.equal(wsWatch.taskId, null);

  // Cancelling worker-owned watches leaves manager-owned watches untouched.
  assert.equal(store.cancelWatchesForTask(task.id, "worker"), 1);
  assert.equal(store.watch(workerWatch.id)?.status, "cancelled");
  assert.equal(store.watch(mgrTaskWatch.id)?.status, "active");
  assert.equal(store.watch(wsWatch.id)?.status, "active");
});
