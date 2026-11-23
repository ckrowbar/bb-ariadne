import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMPTY_EXECUTION,
  formatExecutionSummary,
  hasExecutionOverrides,
  mergeExecution,
  normalizeExecution,
  parseExecutionJson,
  serializeExecutionJson,
  toSpawnExecutionArgs,
} from "./execution.ts";

test("normalizeExecution trims strings and drops invalid reasoning levels", () => {
  assert.deepEqual(
    normalizeExecution({
      providerId: "  claude-code  ",
      model: " ",
      reasoningLevel: "high",
      serviceTier: "",
    }),
    {
      providerId: "claude-code",
      model: null,
      reasoningLevel: "high",
      serviceTier: null,
    },
  );
  assert.deepEqual(
    normalizeExecution({
      providerId: "codex",
      model: "gpt-6.2-sol",
      reasoningLevel: "bogus",
      serviceTier: "fast",
    }),
    {
      providerId: "codex",
      model: "gpt-6.2-sol",
      reasoningLevel: null,
      serviceTier: "fast",
    },
  );
});

test("serializeExecutionJson and parseExecutionJson round-trip and omit empty configs", () => {
  assert.equal(serializeExecutionJson(EMPTY_EXECUTION), null);
  assert.deepEqual(parseExecutionJson(null), EMPTY_EXECUTION);
  assert.deepEqual(parseExecutionJson("not json"), EMPTY_EXECUTION);

  const cfg = {
    providerId: "claude-code",
    model: "claude-sonnet-5-5",
    reasoningLevel: "medium" as const,
    serviceTier: "fast",
  };
  const json = serializeExecutionJson(cfg);
  assert.ok(json !== null);
  assert.deepEqual(parseExecutionJson(json), cfg);
  assert.equal(hasExecutionOverrides(cfg), true);
  assert.equal(hasExecutionOverrides(EMPTY_EXECUTION), false);
});

test("mergeExecution preserves base on empty override and resets incompatible fields on provider or model change", () => {
  const base = {
    providerId: "claude-code",
    model: "claude-opus-5-5",
    reasoningLevel: "high" as const,
    serviceTier: "fast",
  };

  assert.deepEqual(mergeExecution(base, EMPTY_EXECUTION), base);

  // Switching provider drops base model, reasoning, and serviceTier.
  assert.deepEqual(
    mergeExecution(base, { providerId: "codex", model: "gpt-6.2-sol", reasoningLevel: "medium", serviceTier: null }),
    { providerId: "codex", model: "gpt-6.2-sol", reasoningLevel: "medium", serviceTier: null },
  );
  assert.deepEqual(mergeExecution(base, { providerId: "codex" }), {
    providerId: "codex",
    model: null,
    reasoningLevel: null,
    serviceTier: null,
  });

  // Switching model on same provider drops base reasoning and serviceTier unless re-specified.
  assert.deepEqual(mergeExecution(base, { model: "claude-haiku-5-5" }), {
    providerId: "claude-code",
    model: "claude-haiku-5-5",
    reasoningLevel: null,
    serviceTier: null,
  });

  // Changing reasoning without changing model keeps provider, model, and serviceTier.
  assert.deepEqual(mergeExecution(base, { reasoningLevel: "low" }), {
    providerId: "claude-code",
    model: "claude-opus-5-5",
    reasoningLevel: "low",
    serviceTier: "fast",
  });
});

test("toSpawnExecutionArgs omits empty fields and sets explicit executionInputSources", () => {
  assert.deepEqual(toSpawnExecutionArgs(EMPTY_EXECUTION), {});

  assert.deepEqual(
    toSpawnExecutionArgs({
      providerId: "claude-code",
      model: "claude-sonnet-5-5",
      reasoningLevel: "high",
      serviceTier: null,
    }),
    {
      providerId: "claude-code",
      model: "claude-sonnet-5-5",
      reasoningLevel: "high",
      executionInputSources: {
        providerId: "explicit",
        model: "explicit",
        reasoningLevel: "explicit",
        permissionMode: "explicit",
      },
    },
  );
});

test("formatExecutionSummary renders compact labels and skips default tier", () => {
  assert.equal(formatExecutionSummary(EMPTY_EXECUTION), null);
  assert.equal(
    formatExecutionSummary({
      providerId: "claude-code",
      model: "claude-sonnet-5-5",
      reasoningLevel: "high",
      serviceTier: "default",
    }),
    "claude-code / claude-sonnet-5-5 · high",
  );
  assert.equal(
    formatExecutionSummary({
      providerId: "claude-code",
      model: "claude-opus-5-5",
      reasoningLevel: "max",
      serviceTier: "fast",
    }),
    "claude-code / claude-opus-5-5 · max · fast",
  );
});
