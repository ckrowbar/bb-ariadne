import assert from "node:assert/strict";
import { test } from "node:test";
import type { Task } from "./contract.ts";
import { EMPTY_EXECUTION } from "./execution.ts";
import { computeTaskAttention, findDependencyCycle, isDependencySatisfied, planQueuedDispatch } from "./scheduler.ts";

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    workstream: "ws",
    title: overrides.id,
    links: [],
    workerThreadId: null,
    environmentId: null,
    branch: null,
    status: "queued",
    prUrl: null,
    pr: null,
    summary: null,
    harvested: false,
    prompt: "do it",
    baseBranch: null,
    projectId: null,
    execution: { ...EMPTY_EXECUTION },
    dependsOn: [],
    dependsMode: "done",
    verifyMode: "auto",
    handoff: null,
    reactionCounts: {},
    contextTokens: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

test("findDependencyCycle detects direct and transitive cycles", () => {
  const tasks = [
    makeTask({ id: "t_a", dependsOn: [] }),
    makeTask({ id: "t_b", dependsOn: ["t_a"] }),
    makeTask({ id: "t_c", dependsOn: ["t_b"] }),
  ];
  assert.equal(findDependencyCycle(tasks, "t_a", []), null);
  assert.deepEqual(findDependencyCycle(tasks, "t_a", ["t_a"]), ["t_a", "t_a"]);
  assert.deepEqual(findDependencyCycle(tasks, "t_a", ["t_c"]), ["t_a", "t_c", "t_b", "t_a"]);
});

test("isDependencySatisfied respects done vs pr-opened modes", () => {
  assert.equal(isDependencySatisfied(makeTask({ id: "a", status: "running" }), "done"), false);
  assert.equal(isDependencySatisfied(makeTask({ id: "a", status: "in-review", prUrl: "https://github.com/o/r/pull/1" }), "done"), false);
  assert.equal(isDependencySatisfied(makeTask({ id: "a", status: "done" }), "done"), true);

  assert.equal(isDependencySatisfied(makeTask({ id: "a", status: "in-review" }), "pr-opened"), true);
  assert.equal(isDependencySatisfied(makeTask({ id: "a", status: "running", prUrl: "https://github.com/o/r/pull/1" }), "pr-opened"), true);
  assert.equal(isDependencySatisfied(makeTask({ id: "a", status: "running" }), "pr-opened"), false);
});

test("planQueuedDispatch enforces dependencies, concurrency cap, FIFO order and dropped blockers", () => {
  const tasks = [
    makeTask({ id: "t_run", status: "running", createdAt: 1 }),
    makeTask({ id: "t_done", status: "done", createdAt: 2 }),
    makeTask({ id: "t_drop", status: "dropped", createdAt: 3 }),
    makeTask({ id: "t_wait", status: "waiting", createdAt: 4 }), // waiting does NOT consume a concurrency slot
    makeTask({ id: "t_q1", status: "queued", dependsOn: ["t_done"], createdAt: 10 }),
    makeTask({ id: "t_q2", status: "queued", dependsOn: [], createdAt: 20 }),
    makeTask({ id: "t_q3", status: "queued", dependsOn: ["t_run"], createdAt: 5 }),
    makeTask({ id: "t_q4", status: "queued", dependsOn: ["t_drop"], createdAt: 6 }),
  ];

  const plan = planQueuedDispatch(tasks, 2);
  // 1 running slot used, 1 free -> t_q1 (createdAt 10) wins over t_q2 (createdAt 20); t_q3 waits on t_run.
  assert.deepEqual(plan.ready.map((t) => t.id), ["t_q1"]);
  assert.deepEqual(
    plan.blockedByDropped.map((b) => ({ task: b.task.id, dropped: b.droppedDeps.map((d) => d.id) })),
    [{ task: "t_q4", dropped: ["t_drop"] }],
  );

  // With cap 3, both t_q1 and t_q2 dispatch.
  const plan3 = planQueuedDispatch(tasks, 3);
  assert.deepEqual(plan3.ready.map((t) => t.id), ["t_q1", "t_q2"]);
});

test("computeTaskAttention derives lanes from facts", () => {
  assert.equal(computeTaskAttention(makeTask({ id: "a", status: "verifying" }), []).lane, "verifying");
  assert.equal(computeTaskAttention(makeTask({ id: "a", status: "blocked" }), []).lane, "needs-you");
  assert.equal(
    computeTaskAttention(
      makeTask({
        id: "a",
        status: "in-review",
        pr: {
          number: 5,
          title: "t",
          url: "https://github.com/o/r/pull/5",
          state: "open",
          attention: "ready_to_merge",
          checks: { state: "passing", passed: 2, failed: 0, pending: 0 },
        },
      }),
      [],
    ).lane,
    "ready-to-merge",
  );
  assert.equal(
    computeTaskAttention(
      makeTask({
        id: "a",
        status: "in-review",
        pr: {
          number: 5,
          title: "t",
          url: "https://github.com/o/r/pull/5",
          state: "open",
          attention: "checks_failed",
          checks: { state: "failing", passed: 1, failed: 1, pending: 0 },
        },
      }),
      [],
    ).lane,
    "needs-you",
  );
  const waiting = computeTaskAttention(makeTask({ id: "a", status: "waiting" }), [
    { status: "active", kind: "pr-merged", target: "o/r#9" },
  ]);
  assert.equal(waiting.lane, "waiting");
  assert.match(waiting.reason ?? "", /pr-merged: o\/r#9/);
});
