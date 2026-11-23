import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { openStore } from "./db.ts";

function memoryStore() {
  const db = new Database(":memory:");
  const bb = {
    storage: {
      database: () => db,
      migrate: (target: Database.Database, statements: string[]) => statements.forEach((sql) => target.exec(sql)),
    },
  } as unknown as BbPluginApi;
  return { db, store: openStore(bb) };
}

function seed(store: ReturnType<typeof memoryStore>["store"], name: string, ariadne: string, worker: string) {
  store.insertWorkstream(name, ariadne, "proj", []);
  const task = store.insertTask({ workstream: name, title: `${name} task`, links: [], workerThreadId: worker, environmentId: null });
  store.writeNote(name, "overview", "body", ariadne);
  store.event("worker-spawned", worker, name, task.id);
  store.digestChanged(`pr:${task.id}`, "open");
  store.logStaging({ workstream: name, workerThreadId: worker, taskId: task.id, service: "svc", branch: "b", purpose: "p" });
  return task;
}

const count = (db: Database.Database, sql: string, ...params: unknown[]) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get(...params) as { n: number }).n;

test("deleting a workstream removes only its rows and keeps the staging log", () => {
  const { db, store } = memoryStore();
  const gone = seed(store, "gone", "thr_a1", "thr_w1");
  const kept = seed(store, "kept", "thr_a2", "thr_w2");

  store.deleteWorkstream("gone");

  assert.equal(store.workstream("gone"), undefined);
  assert.equal(store.task(gone.id), undefined);
  assert.deepEqual(store.notes("gone"), []);
  assert.equal(count(db, "note_revisions WHERE workstream = ?", "gone"), 0);
  assert.equal(count(db, "events WHERE workstream = ?", "gone"), 0);
  assert.equal(count(db, "digest_state WHERE key = ?", `pr:${gone.id}`), 0);
  assert.equal(count(db, "staging_log WHERE workstream = ?", "gone"), 1);

  assert.ok(store.workstream("kept"));
  assert.ok(store.task(kept.id));
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
