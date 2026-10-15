import assert from "node:assert/strict";
import { test } from "node:test";
import { boardRow } from "./board.ts";
import type { Task } from "./contract";

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
