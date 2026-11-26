import assert from "node:assert/strict";
import { test } from "node:test";
import type { PrSummary } from "./contract.ts";
import {
  decidePrReaction,
  isTransientProviderError,
  shouldCompactManager,
  shouldRotateWorker,
  shouldRunVerifier,
} from "./reactions.ts";

const defaultPolicy = {
  autoReactCi: true,
  autoReactConflicts: true,
  autoReactReviews: false,
  maxReactionRetries: 2,
};

function makePr(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    number: 42,
    title: "Test PR",
    url: "https://github.com/o/r/pull/42",
    state: "open",
    attention: "none",
    checks: { state: "passing", passed: 3, failed: 0, pending: 0 },
    updatedAt: "2026-11-24T12:00:00Z",
    reviewState: "none",
    mergeableState: "mergeable",
    ...overrides,
  };
}

test("decidePrReaction auto-fixes CI up to retry cap, then escalates", () => {
  const failingPr = makePr({
    attention: "checks_failed",
    checks: { state: "failing", passed: 2, failed: 1, pending: 0 },
  });

  // Busy worker is left alone.
  assert.equal(decidePrReaction({ status: "in-review", reactionCounts: {} }, failingPr, true, defaultPolicy).kind, "none");

  const r1 = decidePrReaction({ status: "in-review", reactionCounts: {} }, failingPr, false, defaultPolicy);
  assert.equal(r1.kind, "auto-fix-ci");
  if (r1.kind === "auto-fix-ci") assert.equal(r1.attempt, 1);

  const r2 = decidePrReaction({ status: "in-review", reactionCounts: { ci_failed: 1 } }, failingPr, false, defaultPolicy);
  assert.equal(r2.kind, "auto-fix-ci");
  if (r2.kind === "auto-fix-ci") assert.equal(r2.attempt, 2);

  const r3 = decidePrReaction({ status: "in-review", reactionCounts: { ci_failed: 2 } }, failingPr, false, defaultPolicy);
  assert.equal(r3.kind, "escalate");
});

test("decidePrReaction handles conflicts, changes_requested policy, ready_to_merge and merged", () => {
  const conflictsPr = makePr({ attention: "conflicts", mergeableState: "conflicts" });
  assert.equal(decidePrReaction({ status: "in-review", reactionCounts: {} }, conflictsPr, false, defaultPolicy).kind, "auto-rebase");

  const reviewPr = makePr({ attention: "changes_requested", reviewState: "changes_requested" });
  assert.equal(decidePrReaction({ status: "in-review", reactionCounts: {} }, reviewPr, false, defaultPolicy).kind, "escalate");
  assert.equal(
    decidePrReaction({ status: "in-review", reactionCounts: {} }, reviewPr, false, { ...defaultPolicy, autoReactReviews: true }).kind,
    "auto-review-feedback",
  );

  const readyPr = makePr({ attention: "ready_to_merge" });
  assert.equal(decidePrReaction({ status: "in-review", reactionCounts: {} }, readyPr, false, defaultPolicy).kind, "escalate");

  const mergedPr = makePr({ state: "merged", attention: "merged" });
  assert.equal(decidePrReaction({ status: "in-review", reactionCounts: {} }, mergedPr, false, defaultPolicy).kind, "mark-done");
  assert.equal(decidePrReaction({ status: "done", reactionCounts: {} }, mergedPr, false, defaultPolicy).kind, "none");

  // Draft PR stays quiet while checks are pending or absent, and escalates once checks pass.
  const draftPending = makePr({
    attention: "draft",
    checks: { state: "pending", passed: 1, failed: 0, pending: 2 },
  });
  assert.equal(decidePrReaction({ status: "in-review", reactionCounts: {} }, draftPending, false, defaultPolicy).kind, "none");

  const draftNoChecks = makePr({
    attention: "draft",
    checks: { state: "passing", passed: 0, failed: 0, pending: 0 },
  });
  assert.equal(decidePrReaction({ status: "in-review", reactionCounts: {} }, draftNoChecks, false, defaultPolicy).kind, "none");

  const draftGreen = makePr({
    attention: "draft",
    checks: { state: "passing", passed: 4, failed: 0, pending: 0 },
  });
  const greenDecision = decidePrReaction({ status: "in-review", reactionCounts: {} }, draftGreen, false, defaultPolicy);
  assert.equal(greenDecision.kind, "escalate");
  if (greenDecision.kind === "escalate") {
    assert.equal(greenDecision.signature, "draft_green:42");
  }
});

test("isTransientProviderError distinguishes temporary gateway/network errors from permanent ones", () => {
  assert.equal(isTransientProviderError("API Error: 503 AI Gateway requires a foreground login. This is temporary."), true);
  assert.equal(isTransientProviderError("429 Too Many Requests"), true);
  assert.equal(isTransientProviderError("ECONNRESET socket hang up"), true);
  assert.equal(isTransientProviderError("Invalid parameter: unknown model foo"), false);
  assert.equal(isTransientProviderError(""), false);
  assert.equal(isTransientProviderError(undefined), false);
});

test("context rotation, manager compaction and verifier gating rules", () => {
  assert.equal(shouldRotateWorker(null, 160_000), false);
  assert.equal(shouldRotateWorker(159_999, 160_000), false);
  assert.equal(shouldRotateWorker(160_000, 160_000), true);
  assert.equal(shouldRotateWorker(500_000, 0), false);

  assert.equal(shouldCompactManager(139_999, 140_000), false);
  assert.equal(shouldCompactManager(140_000, 140_000), true);

  assert.equal(shouldRunVerifier({ verifyMode: "off", verifyByDefault: true, hasEnvironment: true, hasPrOrDiff: true }), false);
  assert.equal(shouldRunVerifier({ verifyMode: "always", verifyByDefault: false, hasEnvironment: true, hasPrOrDiff: false }), true);
  assert.equal(shouldRunVerifier({ verifyMode: "always", verifyByDefault: true, hasEnvironment: false, hasPrOrDiff: true }), false);
  assert.equal(shouldRunVerifier({ verifyMode: "auto", verifyByDefault: true, hasEnvironment: true, hasPrOrDiff: true }), true);
  assert.equal(shouldRunVerifier({ verifyMode: "auto", verifyByDefault: true, hasEnvironment: true, hasPrOrDiff: false }), false);
});
