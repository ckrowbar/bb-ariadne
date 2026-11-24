// One board row format, shared by the ariadne_board tool and `bb ariadne board`.
import type { Task, TaskRun, Watch } from "./contract.ts";

export interface BoardRowExtras {
  watches?: Watch[];
  runs?: TaskRun[];
}

function formatTokens(tokens: number | null): string | null {
  if (tokens === null || tokens <= 0) return null;
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k tok` : `${tokens} tok`;
}

/**
 * Formats a task as one board line. `mention` renders the worker as an
 * @thread: reference, which BB links in agent output but not in a terminal.
 */
export function boardRow(t: Task, mention: boolean, extras?: BoardRowExtras): string {
  const worker = t.workerThreadId === null ? "-" : mention ? `@thread:${t.workerThreadId}` : t.workerThreadId;
  const pr = t.pr === null ? (t.prUrl ?? "no PR") : `PR #${t.pr.number} ${t.pr.state}, checks ${t.pr.checks.state} ${t.pr.url}`;
  const tags: string[] = [t.status];
  if (t.harvested) tags.push("harvested");
  const activeWatches = extras?.watches?.filter((w) => w.status === "active") ?? [];
  const metaParts: string[] = [];
  if (t.dependsOn.length > 0) metaParts.push(`deps ${t.dependsOn.join(",")}`);
  if (activeWatches.length > 0) {
    metaParts.push(`watching ${activeWatches.map((w) => `${w.kind}:${w.target}`).join(",")}`);
  }
  const tok = formatTokens(t.contextTokens);
  if (tok !== null) metaParts.push(tok);
  const runCount = extras?.runs?.length ?? 0;
  if (runCount > 1) metaParts.push(`${runCount} runs`);
  const meta = metaParts.length > 0 ? ` | ${metaParts.join(", ")}` : "";
  return `${t.id} [${tags.join(", ")}] ${t.title} | worker ${worker} | ${t.branch ?? "-"} | ${pr}${meta}${t.summary ? ` | ${t.summary}` : ""}`;
}
