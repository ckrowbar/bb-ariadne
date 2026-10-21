import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkerTurns, completedWorkerId } from "./notifications.ts";

test("parses the worker from BB's child-completed text", () => {
  assert.equal(completedWorkerId("[bb system]\n\n@thread:thr_95a8u33hn7 completed:\n\nI opened draft PR #2"), "thr_95a8u33hn7");
  assert.equal(completedWorkerId("[bb system]\n\n@thread:thr_95a8u33hn7 failed:\n\nboom"), null);
  assert.equal(completedWorkerId("@thread:thr_95a8u33hn7 completed: quoted by the user"), null);
});

test("a completion is redundant only after a report or a user-started turn", () => {
  const turns = new WorkerTurns();
  const w = "thr_w";
  assert.equal(turns.redundant(w), null, "unknown turns pass through");

  turns.started(w, false);
  assert.equal(turns.redundant(w), null, "an Ariadne-started turn with no report");
  turns.reported(w);
  assert.match(turns.redundant(w) ?? "", /reported/);

  turns.started(w, true);
  assert.match(turns.redundant(w) ?? "", /user started/);

  turns.forget(w);
  assert.equal(turns.redundant(w), null, "a steer from Ariadne forwards the answer");

  turns.reported("thr_restarted");
  assert.match(turns.redundant("thr_restarted") ?? "", /reported/, "reports count even without a recorded start");
});
