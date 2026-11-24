import assert from "node:assert/strict";
import { test } from "node:test";
import { boardRow } from "./board.ts";
import type { Task } from "./contract.ts";
import { EMPTY_EXECUTION } from "./execution.ts";

const task: Task = {
  id: "t_a792b619",
  workstream: "ariadne-e2e",
  title: "e2e toy task",
  links: [],
  workerThreadId: "thr_fad9p9ngt7",
  environmentId: null,
  branch: "cyrus.kalafchi/ARIADNE-E2E/toy-test",
  status: "done",
  prUrl: null,
  pr: {
    number: 7,
    title: "Toy",
    url: "https://github.com/o/r/pull/7",
    state: "open",
    attention: "none",
    checks: { state: "passing", passed: 3, failed: 0, pending: 0 },
  },
  summary: "Branch renamed",
  harvested: true,
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
  createdAt: 0,
  updatedAt: 0,
};

test("CLI and tool rows carry the same fields", () => {
  const tool = boardRow(task, true);
  const cli = boardRow(task, false);
  assert.equal(cli, tool.replace("@thread:", ""));
  for (const field of ["[done, harvested]", task.branch!, "checks passing", task.pr!.url, task.summary!]) {
    assert.ok(cli.includes(field), `CLI row is missing ${field}`);
  }
});

test("rows without a PR or worker", () => {
  const row = boardRow({ ...task, workerThreadId: null, branch: null, pr: null, summary: null, harvested: false }, false);
  assert.equal(row, "t_a792b619 [done] e2e toy task | worker - | - | no PR");
});

test("rows surface dependencies, watches, context tokens and multiple runs", () => {
  const row = boardRow(
    { ...task, status: "waiting", harvested: false, dependsOn: ["t_dep1"], contextTokens: 142_300 },
    false,
    {
      watches: [
        {
          id: "w_1",
          workstream: "ariadne-e2e",
          taskId: task.id,
          kind: "pr-merged",
          target: "ddoghq/k8s#18506",
          resumePrompt: "continue",
          status: "active",
          lastCheckedAt: null,
          lastState: null,
          expiresAt: null,
          createdAt: 0,
          triggeredAt: null,
        },
      ],
      runs: [
        {
          id: 1,
          taskId: task.id,
          workstream: "ariadne-e2e",
          runNumber: 1,
          role: "worker",
          phase: "implement",
          threadId: "thr_1",
          status: "superseded",
          summary: null,
          contextTokens: 170_000,
          startedAt: 0,
          endedAt: 1,
        },
        {
          id: 2,
          taskId: task.id,
          workstream: "ariadne-e2e",
          runNumber: 2,
          role: "worker",
          phase: "fix-ci",
          threadId: "thr_2",
          status: "running",
          summary: null,
          contextTokens: 142_300,
          startedAt: 2,
          endedAt: null,
        },
      ],
    },
  );
  for (const part of ["deps t_dep1", "watching pr-merged:ddoghq/k8s#18506", "142k tok", "2 runs"]) {
    assert.ok(row.includes(part), `expected ${part} in ${row}`);
  }
});
