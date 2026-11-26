// Durable zero-token watch parsing and evaluation.
// Watches run in the deterministic control plane instead of LLM bash polling loops.
import type { PrSummary, Task, Watch } from "./contract.ts";

export interface GitHubPrRef {
  owner: string;
  repo: string;
  number: number;
}

export interface ExternalPrState {
  number: number;
  url: string;
  state: "open" | "closed" | "merged";
  checksState: "passing" | "failing" | "pending" | "no_checks" | "unknown";
  failedCount: number;
  pendingCount: number;
  passedCount: number;
}

export interface WatchEvalContext {
  now: number;
  getTask(taskId: string): Task | undefined;
  getTaskPr(task: Task): Promise<PrSummary | null>;
  fetchExternalPr(ref: GitHubPrRef): Promise<ExternalPrState>;
  runCommand(task: Task | null, command: string): Promise<{ ok: boolean; output: string }>;
}

export type WatchEvalOutcome =
  | { status: "pending"; state: string }
  | { status: "triggered"; state: string; detail: string }
  | { status: "expired"; state: string; detail: string };

/**
 * Parses a GitHub PR target such as:
 * - "https://github.com/acme/app/pull/42"
 * - "acme/infra-config#42"
 */
export function parsePrTarget(target: string): GitHubPrRef | null {
  const trimmed = target.trim();
  const urlMatch = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i.exec(trimmed);
  if (urlMatch !== null) {
    return { owner: urlMatch[1]!, repo: urlMatch[2]!, number: Number(urlMatch[3]!) };
  }
  const shortMatch = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/.exec(trimmed);
  if (shortMatch !== null) {
    return { owner: shortMatch[1]!, repo: shortMatch[2]!, number: Number(shortMatch[3]!) };
  }
  return null;
}

/**
 * Parses a timer target into an epoch millisecond timestamp.
 * Accepts an epoch ms integer (10-15 digits), ISO-8601 date string, or relative duration like "15m", "2h", "30s".
 */
export function parseTimerTarget(target: string, now = Date.now()): number | null {
  const trimmed = target.trim();
  if (/^\d+$/.test(trimmed)) {
    if (trimmed.length < 10 || trimmed.length > 15) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  const rel = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i.exec(trimmed);
  if (rel !== null) {
    const amount = Number(rel[1]!);
    const unit = rel[2]!.toLowerCase();
    const mult = unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return Math.round(now + amount * mult);
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

export async function evaluateWatch(watch: Watch, task: Task | null, ctx: WatchEvalContext): Promise<WatchEvalOutcome> {
  if (watch.expiresAt !== null && ctx.now >= watch.expiresAt) {
    return {
      status: "expired",
      state: "expired",
      detail: `Watch ${watch.id} (${watch.kind} ${watch.target}) expired without triggering.`,
    };
  }

  switch (watch.kind) {
    case "timer": {
      const targetMs = parseTimerTarget(watch.target, watch.createdAt);
      if (targetMs === null) {
        return { status: "expired", state: "invalid-timer", detail: `Invalid timer target ${JSON.stringify(watch.target)}.` };
      }
      if (ctx.now >= targetMs) {
        return {
          status: "triggered",
          state: "due",
          detail: `Timer reached ${new Date(targetMs).toISOString()}.`,
        };
      }
      const remainingMin = Math.max(1, Math.round((targetMs - ctx.now) / 60_000));
      return { status: "pending", state: `${remainingMin}m left` };
    }

    case "task-done": {
      const target = ctx.getTask(watch.target);
      if (target === undefined) {
        return {
          status: "triggered",
          state: "missing",
          detail: `Watched task ${watch.target} no longer exists.`,
        };
      }
      if (target.status === "done") {
        return {
          status: "triggered",
          state: "done",
          detail: `Task ${target.id} (${target.title}) is done.${target.prUrl ? ` PR: ${target.prUrl}` : ""}${target.summary ? ` Summary: ${target.summary}` : ""}`,
        };
      }
      if (target.status === "dropped") {
        return {
          status: "triggered",
          state: "dropped",
          detail: `Watched task ${target.id} (${target.title}) was dropped.`,
        };
      }
      return { status: "pending", state: target.status };
    }

    case "pr-merged":
    case "pr-checks": {
      let state: "open" | "closed" | "merged";
      let checksState: string;
      let failedCount = 0;
      let pendingCount = 0;
      let passedCount = 0;
      let url = watch.target;

      if (watch.target === "self") {
        if (task === null) {
          return { status: "expired", state: "no-task", detail: "Watch target 'self' requires an associated task." };
        }
        const pr = await ctx.getTaskPr(task);
        if (pr === null) return { status: "pending", state: "no-pr" };
        state = pr.state === "merged" ? "merged" : pr.state === "closed" ? "closed" : "open";
        checksState = pr.checks.state;
        failedCount = pr.checks.failed;
        pendingCount = pr.checks.pending;
        passedCount = pr.checks.passed;
        url = pr.url;
      } else {
        const ref = parsePrTarget(watch.target);
        if (ref === null) {
          return { status: "expired", state: "invalid-pr", detail: `Invalid PR reference ${JSON.stringify(watch.target)}.` };
        }
        const pr = await ctx.fetchExternalPr(ref);
        state = pr.state;
        checksState = pr.checksState;
        failedCount = pr.failedCount;
        pendingCount = pr.pendingCount;
        passedCount = pr.passedCount;
        url = pr.url;
      }

      if (watch.kind === "pr-merged") {
        if (state === "merged") {
          return { status: "triggered", state: "merged", detail: `PR merged: ${url}` };
        }
        if (state === "closed") {
          return { status: "triggered", state: "closed", detail: `PR closed without merging: ${url}` };
        }
        return { status: "pending", state: `open (checks ${checksState})` };
      }

      // pr-checks
      if (state === "merged" || state === "closed") {
        return { status: "triggered", state, detail: `PR is already ${state}: ${url}` };
      }
      if (checksState === "passing") {
        return {
          status: "triggered",
          state: "passing",
          detail: `PR checks passed (${passedCount} passed): ${url}`,
        };
      }
      if (checksState === "failing") {
        return {
          status: "triggered",
          state: "failing",
          detail: `PR checks failed (${failedCount} failed, ${passedCount} passed, ${pendingCount} pending): ${url}`,
        };
      }
      return { status: "pending", state: `checks ${checksState} (${pendingCount} pending)` };
    }

    case "command": {
      const result = await ctx.runCommand(task, watch.target);
      if (result.ok) {
        const snippet = result.output.trim().slice(0, 600);
        return {
          status: "triggered",
          state: "ok",
          detail: snippet === "" ? `Check command succeeded: ${watch.target}` : `Check command succeeded:\n${snippet}`,
        };
      }
      return { status: "pending", state: result.output.trim().slice(0, 120) || "not ready" };
    }
  }
}
