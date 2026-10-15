// One board row format, shared by the ariadne_board tool and `bb ariadne board`.
import type { Task } from "./contract";

/**
 * Formats a task as one board line. `mention` renders the worker as an
 * @thread: reference, which BB links in agent output but not in a terminal.
 */
export function boardRow(t: Task, mention: boolean): string {
  const worker = t.workerThreadId === null ? "-" : mention ? `@thread:${t.workerThreadId}` : t.workerThreadId;
  const pr = t.pr === null ? (t.prUrl ?? "no PR") : `PR #${t.pr.number} ${t.pr.state}, checks ${t.pr.checks.state} ${t.pr.url}`;
  return `${t.id} [${t.status}${t.harvested ? ", harvested" : ""}] ${t.title} | worker ${worker} | ${t.branch ?? "-"} | ${pr}${t.summary ? ` | ${t.summary}` : ""}`;
}
