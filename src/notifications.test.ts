import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { openStore } from "./db.ts";
import { WorkerTurns, prNeedsAttention } from "./notifications.ts";

test("Ariadne hears once per streak of user or background turns", () => {
  const turns = new WorkerTurns();
  const w = "thr_w";
  assert.equal(turns.finished(w), null, "unknown turns say nothing");

  turns.started(w, "ariadne");
  turns.active(w);
  assert.equal(turns.finished(w), null, "a turn Ariadne started");

  turns.started(w, "orchestrator");
  turns.active(w);
  assert.equal(turns.finished(w), null, "a turn the orchestrator started");

  turns.started(w, "user");
  turns.active(w);
  assert.equal(turns.finished(w), "user");
  turns.started(w, "user");
  assert.equal(turns.finished(w), null, "the same conversation is flagged once");

  turns.active(w);
  assert.equal(turns.finished(w), "background", "a wake with no message is the worker's background task");
  turns.active(w);
  assert.equal(turns.finished(w), null, "repeated watcher wakes are flagged once");

  turns.active(w);
  turns.reported(w);
  assert.equal(turns.finished(w), null, "a report ends the streak");
  turns.active(w);
  assert.equal(turns.finished(w), "background", "so the next wake is flagged again");

  turns.started(w, "user");
  turns.steered(w);
  assert.equal(turns.finished(w), null, "a steer from Ariadne makes the turn Ariadne's");
  turns.started(w, "user");
  assert.equal(turns.finished(w), "user");
});

test("SQLite-backed WorkerTurns persists streak state across plugin reloads", () => {
  const db = new Database(":memory:");
  const bb = {
    storage: {
      database: () => db,
      migrate: (target: Database.Database, statements: string[]) => statements.forEach((sql) => target.exec(sql)),
    },
  } as unknown as BbPluginApi;
  const store = openStore(bb);

  const beforeReload = new WorkerTurns(store.turnState);
  beforeReload.started("thr_w1", "user");
  assert.equal(beforeReload.finished("thr_w1"), "user");

  // Simulate reload: fresh WorkerTurns instance over the same SQLite store.
  const afterReload = new WorkerTurns(store.turnState);
  afterReload.started("thr_w1", "user");
  assert.equal(afterReload.finished("thr_w1"), null, "streak persists after reload");
});

test("draft and pending PRs stay out of the digest", () => {
  const pr = (attention: string, checks = "no_checks") => ({ attention, checks: { state: checks } });
  assert.equal(prNeedsAttention(pr("draft")), false);
  assert.equal(prNeedsAttention(pr("checks_pending", "pending")), false);
  assert.equal(prNeedsAttention(pr("none", "passing")), false);
  assert.equal(prNeedsAttention(pr("draft", "failing")), true, "failing checks count even on a draft");
  assert.equal(prNeedsAttention(pr("changes_requested", "passing")), true);
  assert.equal(prNeedsAttention(pr("merged", "passing")), true);
});
