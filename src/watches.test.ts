import assert from "node:assert/strict";
import { test } from "node:test";
import type { Task, Watch } from "./contract.ts";
import { EMPTY_EXECUTION } from "./execution.ts";
import { evaluateWatch, parsePrTarget, parseTimerTarget, type WatchEvalContext } from "./watches.ts";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t_1",
    workstream: "ws",
    title: "task",
    links: [],
    workerThreadId: "thr_w1",
    environmentId: "env_1",
    branch: "b",
    status: "waiting",
    prUrl: null,
    pr: null,
    summary: null,
    harvested: false,
    prompt: null,
    baseBranch: null,
    projectId: null,
    execution: { ...EMPTY_EXECUTION },
    dependsOn: [],
    dependsMode: "done",
    verifyMode: "auto",
    handoff: null,
    reactionCounts: {},
    contextTokens: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function makeWatch(overrides: Partial<Watch>): Watch {
  return {
    id: "w_1",
    workstream: "ws",
    taskId: "t_1",
    owner: "worker",
    kind: "timer",
    target: "10m",
    resumePrompt: "continue",
    status: "active",
    lastCheckedAt: null,
    lastState: null,
    expiresAt: 10_000_000,
    createdAt: 1000,
    triggeredAt: null,
    ...overrides,
  };
}

function baseCtx(overrides: Partial<WatchEvalContext> = {}): WatchEvalContext {
  return {
    now: 2000,
    getTask: () => undefined,
    getTaskPr: async () => null,
    fetchExternalPr: async () => ({
      number: 42,
      url: "https://github.com/acme/infra/pull/42",
      state: "open",
      checksState: "pending",
      failedCount: 0,
      pendingCount: 2,
      passedCount: 1,
    }),
    runCommand: async () => ({ ok: false, output: "still waiting" }),
    ...overrides,
  };
}

test("parsePrTarget handles GitHub URLs and owner/repo#number", () => {
  assert.deepEqual(parsePrTarget("https://github.com/acme/infra-config/pull/42"), {
    owner: "acme",
    repo: "infra-config",
    number: 42,
  });
  assert.deepEqual(parsePrTarget("acme/app#123"), {
    owner: "acme",
    repo: "app",
    number: 123,
  });
  assert.equal(parsePrTarget("not-a-pr"), null);
});

test("parseTimerTarget supports relative durations, epochs and ISO timestamps", () => {
  assert.equal(parseTimerTarget("30m", 1000), 1000 + 30 * 60_000);
  assert.equal(parseTimerTarget("2h", 0), 7_200_000);
  assert.equal(parseTimerTarget("1795000000000", 0), 1795000000000);
  assert.equal(parseTimerTarget("2026-11-24T12:00:00Z", 0), Date.parse("2026-11-24T12:00:00Z"));
  assert.equal(parseTimerTarget("5000", 0), null);
  assert.equal(parseTimerTarget("bogus", 0), null);
});

test("evaluateWatch handles timer, task-done, external pr-merged, self pr-checks, command and expiry", async () => {
  const task = makeTask();
  const baseNow = 1_795_000_000_000;

  // Timer pending then due.
  const tw = makeWatch({ kind: "timer", target: String(baseNow + 5000), expiresAt: baseNow + 60_000 });
  assert.equal((await evaluateWatch(tw, task, baseCtx({ now: baseNow + 2000 }))).status, "pending");
  assert.equal((await evaluateWatch(tw, task, baseCtx({ now: baseNow + 5000 }))).status, "triggered");

  // Expiry takes precedence.
  assert.equal((await evaluateWatch(makeWatch({ expiresAt: 1500 }), task, baseCtx({ now: 2000 }))).status, "expired");

  // task-done
  const dw = makeWatch({ kind: "task-done", target: "t_up" });
  assert.equal((await evaluateWatch(dw, task, baseCtx({ getTask: () => makeTask({ id: "t_up", status: "running" }) }))).status, "pending");
  assert.equal((await evaluateWatch(dw, task, baseCtx({ getTask: () => makeTask({ id: "t_up", status: "done" }) }))).status, "triggered");

  // External PR merge
  const pw = makeWatch({ kind: "pr-merged", target: "acme/infra#42" });
  assert.equal((await evaluateWatch(pw, task, baseCtx())).status, "pending");
  const merged = await evaluateWatch(
    pw,
    task,
    baseCtx({
      fetchExternalPr: async () => ({
        number: 42,
        url: "https://github.com/acme/infra/pull/42",
        state: "merged",
        checksState: "passing",
        failedCount: 0,
        pendingCount: 0,
        passedCount: 5,
      }),
    }),
  );
  assert.equal(merged.status, "triggered");

  // Self PR checks
  const cw = makeWatch({ kind: "pr-checks", target: "self" });
  const failing = await evaluateWatch(
    cw,
    task,
    baseCtx({
      getTaskPr: async () => ({
        number: 7,
        title: "t",
        url: "https://github.com/o/r/pull/7",
        state: "open",
        attention: "checks_failed",
        checks: { state: "failing", passed: 1, failed: 2, pending: 0 },
      }),
    }),
  );
  assert.equal(failing.status, "triggered");

  // Command watch
  const cmdw = makeWatch({ kind: "command", target: "check-deploy" });
  assert.equal((await evaluateWatch(cmdw, task, baseCtx())).status, "pending");
  assert.equal((await evaluateWatch(cmdw, task, baseCtx({ runCommand: async () => ({ ok: true, output: "live" }) }))).status, "triggered");
});
