import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkerTurns, prNeedsAttention } from "./notifications.ts";

test("Ariadne hears once per streak of user or background turns", () => {
  const turns = new WorkerTurns();
  const w = "thr_w";
  assert.equal(turns.finished(w), null, "unknown turns say nothing");

  turns.started(w, "ariadne");
  turns.active(w);
  assert.equal(turns.finished(w), null, "a turn Ariadne started");

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

test("draft and pending PRs stay out of the digest", () => {
  const pr = (attention: string, checks = "no_checks") => ({ attention, checks: { state: checks } });
  assert.equal(prNeedsAttention(pr("draft")), false);
  assert.equal(prNeedsAttention(pr("checks_pending", "pending")), false);
  assert.equal(prNeedsAttention(pr("none", "passing")), false);
  assert.equal(prNeedsAttention(pr("draft", "failing")), true, "failing checks count even on a draft");
  assert.equal(prNeedsAttention(pr("changes_requested", "passing")), true);
  assert.equal(prNeedsAttention(pr("merged", "passing")), true);
});
