// Pure dependency scheduling and fact-derived attention computation.
import type { TaskAttentionLane } from "./constants.ts";
import type { Task, TaskRun, Watch } from "./contract.ts";

export interface AttentionResult {
  lane: TaskAttentionLane;
  reason: string | null;
}

/**
 * Checks whether adding `candidateDeps` on `taskId` introduces a dependency cycle.
 * Returns the first cycle path if found, or null when acyclic.
 */
export function findDependencyCycle(
  tasks: Pick<Task, "id" | "dependsOn">[],
  taskId: string,
  candidateDeps: string[],
): string[] | null {
  const byId = new Map<string, string[]>();
  for (const t of tasks) byId.set(t.id, t.dependsOn);
  byId.set(taskId, candidateDeps);

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  function dfs(id: string): string[] | null {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }
    if (visited.has(id)) return null;
    visiting.add(id);
    stack.push(id);
    for (const dep of byId.get(id) ?? []) {
      const cycle = dfs(dep);
      if (cycle !== null) return cycle;
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  }

  return dfs(taskId);
}

/** Whether a single upstream task satisfies a downstream dependency edge. */
export function isDependencySatisfied(
  dep: Pick<Task, "status" | "prUrl" | "pr"> | undefined,
  mode: Task["dependsMode"],
): boolean {
  if (dep === undefined) return false;
  if (dep.status === "done") return true;
  if (mode === "pr-opened") {
    return dep.status === "in-review" || dep.prUrl !== null || dep.pr !== null;
  }
  return false;
}

export interface DispatchPlan {
  ready: Task[];
  blockedByDropped: { task: Task; droppedDeps: Task[] }[];
}

/**
 * Computes which `queued` tasks can dispatch now (respecting dependencies and
 * concurrency cap) and which queued tasks are deadlocked by a dropped dependency.
 * FIFO by createdAt so older queued work dispatches first.
 */
export function planQueuedDispatch(allTasks: Task[], maxConcurrentWorkers: number): DispatchPlan {
  const byId = new Map(allTasks.map((t) => [t.id, t]));
  const runningCount = allTasks.filter((t) => t.status === "running" || t.status === "verifying").length;
  const availableSlots = Math.max(0, maxConcurrentWorkers - runningCount);

  const queued = allTasks
    .filter((t) => t.status === "queued")
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

  const ready: Task[] = [];
  const blockedByDropped: { task: Task; droppedDeps: Task[] }[] = [];

  for (const task of queued) {
    const droppedDeps = task.dependsOn
      .map((id) => byId.get(id))
      .filter((d): d is Task => d !== undefined && d.status === "dropped");
    if (droppedDeps.length > 0) {
      blockedByDropped.push({ task, droppedDeps });
      continue;
    }
    if (ready.length >= availableSlots) continue;
    const allSatisfied = task.dependsOn.every((id) => isDependencySatisfied(byId.get(id), task.dependsMode));
    if (allSatisfied) ready.push(task);
  }

  return { ready, blockedByDropped };
}

/**
 * Derives a task's attention lane purely from durable facts (status, PR state,
 * active watches, latest verifier run). Inspired by Composio AO's fact-vs-status split.
 */
export function computeTaskAttention(
  task: Pick<Task, "status" | "pr" | "dependsOn" | "dependsMode">,
  watches: Pick<Watch, "status" | "kind" | "target">[],
  runs: Pick<TaskRun, "role" | "status">[] = [],
): AttentionResult {
  if (task.status === "dropped") return { lane: "dropped", reason: null };
  if (task.status === "done" || task.pr?.state === "merged") return { lane: "done", reason: null };
  if (task.status === "blocked") return { lane: "needs-you", reason: "Blocked" };
  if (task.status === "verifying") return { lane: "verifying", reason: "Clean-context verifier running" };

  if (task.pr !== null) {
    if (task.pr.checks.state === "failing" || task.pr.attention === "checks_failed") {
      return { lane: "needs-you", reason: `CI failing (${task.pr.checks.failed} failed)` };
    }
    if (task.pr.attention === "conflicts" || task.pr.mergeableState === "conflicts") {
      return { lane: "needs-you", reason: "Merge conflicts" };
    }
    if (task.pr.attention === "changes_requested" || task.pr.reviewState === "changes_requested") {
      return { lane: "needs-you", reason: "Changes requested" };
    }
    if (task.pr.attention === "ready_to_merge") {
      return { lane: "ready-to-merge", reason: "Approved and green" };
    }
  }

  if (task.status === "running") return { lane: "running", reason: null };

  const activeWatches = watches.filter((w) => w.status === "active");
  if (task.status === "waiting") {
    const first = activeWatches[0];
    return {
      lane: "waiting",
      reason: first ? `${first.kind}: ${first.target}` : "Waiting on watch",
    };
  }
  if (task.status === "queued") {
    return {
      lane: "queued",
      reason: task.dependsOn.length > 0 ? `Waiting on ${task.dependsOn.join(", ")}` : "Queued for worker slot",
    };
  }
  if (task.status === "in-review") {
    const lastVerify = [...runs].reverse().find((r) => r.role === "verifier");
    const reason =
      lastVerify?.status === "passed"
        ? "Verified, awaiting review"
        : task.pr?.state === "draft"
          ? "Draft PR"
          : "Awaiting review";
    return { lane: "in-review", reason };
  }
  return { lane: "running", reason: null };
}
