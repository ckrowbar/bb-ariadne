import assert from "node:assert/strict";
import { test } from "node:test";
import { ariadneInstructions, MEMORY_INSTRUCTIONS, verifierInstructions, workerInstructions } from "./instructions.ts";

test("the standing orders fit BB's 4096-character cap with long inputs", () => {
  const text = ariadneInstructions({
    workstream: "w".repeat(60),
    links: Array.from({ length: 9 }, () => `https://example.com/${"x".repeat(300)}`),
    projectName: "p".repeat(60),
    pluginCheckout: `/home/someone/${"c".repeat(100)}/bb-plugin-ariadne`,
  });
  assert.ok(text.length <= 4096, `${text.length} characters`);
  assert.match(text, /Never use a blocking question tool/);
  assert.match(text, /Maximize autonomy/);
});

test("memory, worker and verifier instructions fit BB's 4096-character cap and include autonomy rules", () => {
  assert.ok(MEMORY_INSTRUCTIONS.length <= 4096, `${MEMORY_INSTRUCTIONS.length} characters`);
  assert.match(MEMORY_INSTRUCTIONS, /bb memory add --scope project/);
  assert.match(MEMORY_INSTRUCTIONS, /AGENTS\.md/);
  assert.match(MEMORY_INSTRUCTIONS, /workflow improvements/);

  const worker = workerInstructions({
    ariadneThreadId: "thr_abc",
    taskId: "t".repeat(40),
    branchConvention: "b".repeat(200),
  });
  assert.ok(worker.length <= 4096, `${worker.length} characters`);
  assert.match(worker, /bb memory add --scope project/);
  assert.match(worker, /ariadne_watch/);

  const verifier = verifierInstructions({
    taskId: "t".repeat(40),
    workstream: "w".repeat(60),
  });
  assert.ok(verifier.length <= 4096, `${verifier.length} characters`);
  assert.match(verifier, /STRICT READ-ONLY RULE/);
  assert.match(verifier, /ariadne_verify_verdict/);
});
