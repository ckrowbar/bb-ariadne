// Pure deterministic reaction and context-hygiene policy.
// Given durable task/PR/context facts, decides whether the control plane should
// auto-steer a bounded retry, rotate/compact context, mark done, or escalate.
import type { PrSummary, Task } from "./contract.ts";

export interface ReactionPolicy {
  autoReactCi: boolean;
  autoReactConflicts: boolean;
  autoReactReviews: boolean;
  maxReactionRetries: number;
}

export type PrReactionDecision =
  | { kind: "none" }
  | { kind: "mark-done" }
  | { kind: "auto-fix-ci"; reactionKey: "ci_failed"; attempt: number; maxAttempts: number; signature: string }
  | { kind: "auto-rebase"; reactionKey: "conflicts"; attempt: number; maxAttempts: number; signature: string }
  | { kind: "auto-review-feedback"; reactionKey: "changes_requested"; attempt: number; maxAttempts: number; signature: string }
  | { kind: "escalate"; reason: string; signature: string };

/**
 * Evaluates a task's freshly fetched PR facts and returns the deterministic
 * control-plane action. Never triggers while the task's worker is already
 * active or verifying; retry budgets are bounded by `policy.maxReactionRetries`.
 */
export function decidePrReaction(
  task: Pick<Task, "status" | "reactionCounts">,
  pr: PrSummary,
  workerBusy: boolean,
  policy: ReactionPolicy,
): PrReactionDecision {
  if (pr.state === "merged") {
    return task.status === "done" ? { kind: "none" } : { kind: "mark-done" };
  }
  if (pr.state === "closed" || task.status === "dropped" || task.status === "done") {
    return { kind: "none" };
  }
  if (workerBusy || task.status === "verifying") {
    return { kind: "none" };
  }

  const prUpdated = pr.updatedAt ?? "";

  if (pr.checks.state === "failing" || pr.attention === "checks_failed") {
    const signature = `ci_failed:${pr.number}:${pr.checks.failed}:${prUpdated}`;
    const used = task.reactionCounts.ci_failed ?? 0;
    if (policy.autoReactCi && used < policy.maxReactionRetries) {
      return {
        kind: "auto-fix-ci",
        reactionKey: "ci_failed",
        attempt: used + 1,
        maxAttempts: policy.maxReactionRetries,
        signature,
      };
    }
    const why = policy.autoReactCi
      ? `PR #${pr.number} CI is still failing (${pr.checks.failed} failed) after ${used}/${policy.maxReactionRetries} auto-fix attempts.`
      : `PR #${pr.number} CI failed (${pr.checks.failed} failed).`;
    return { kind: "escalate", reason: why, signature };
  }

  if (pr.attention === "conflicts" || pr.mergeableState === "conflicts") {
    const signature = `conflicts:${pr.number}:${prUpdated}`;
    const used = task.reactionCounts.conflicts ?? 0;
    if (policy.autoReactConflicts && used < policy.maxReactionRetries) {
      return {
        kind: "auto-rebase",
        reactionKey: "conflicts",
        attempt: used + 1,
        maxAttempts: policy.maxReactionRetries,
        signature,
      };
    }
    const why = policy.autoReactConflicts
      ? `PR #${pr.number} still has merge conflicts after ${used}/${policy.maxReactionRetries} auto-rebase attempts.`
      : `PR #${pr.number} has merge conflicts.`;
    return { kind: "escalate", reason: why, signature };
  }

  if (pr.attention === "changes_requested" || pr.reviewState === "changes_requested") {
    const signature = `changes_requested:${pr.number}:${prUpdated}`;
    const used = task.reactionCounts.changes_requested ?? 0;
    if (policy.autoReactReviews && used < policy.maxReactionRetries) {
      return {
        kind: "auto-review-feedback",
        reactionKey: "changes_requested",
        attempt: used + 1,
        maxAttempts: policy.maxReactionRetries,
        signature,
      };
    }
    return {
      kind: "escalate",
      reason: `PR #${pr.number} has changes requested (${pr.url}).`,
      signature,
    };
  }

  if (pr.attention === "ready_to_merge") {
    return {
      kind: "escalate",
      reason: `PR #${pr.number} is approved and checks are passing (${pr.url}). Ready for your review/merge.`,
      signature: `ready_to_merge:${pr.number}`,
    };
  }

  return { kind: "none" };
}

/** Whether a worker thread should rotate to a fresh run on the same worktree before taking a new phase. */
export function shouldRotateWorker(contextTokens: number | null, thresholdTokens: number): boolean {
  return thresholdTokens > 0 && contextTokens !== null && contextTokens >= thresholdTokens;
}

/** Whether an idle Ariadne manager thread should auto-compact to prevent context rot. */
export function shouldCompactManager(contextTokens: number | null, thresholdTokens: number): boolean {
  return thresholdTokens > 0 && contextTokens !== null && contextTokens >= thresholdTokens;
}

/** Decides whether a task reporting `done` should run the hidden clean-context verifier. */
export function shouldRunVerifier(input: {
  verifyMode: Task["verifyMode"];
  verifyByDefault: boolean;
  hasEnvironment: boolean;
  hasPrOrDiff: boolean;
}): boolean {
  if (!input.hasEnvironment) return false;
  if (input.verifyMode === "off") return false;
  if (input.verifyMode === "always") return true;
  return input.verifyByDefault && input.hasPrOrDiff;
}
