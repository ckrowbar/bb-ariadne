import assert from "node:assert/strict";
import { test } from "node:test";
import { ariadneInstructions } from "./instructions.ts";

test("the standing orders fit BB's 4096-character cap with long inputs", () => {
  const text = ariadneInstructions({
    workstream: "w".repeat(60),
    links: Array.from({ length: 9 }, () => `https://example.com/${"x".repeat(300)}`),
    projectName: "p".repeat(60),
    pluginCheckout: `/home/someone/${"c".repeat(100)}/bb-plugin-ariadne`,
  });
  assert.ok(text.length <= 4096, `${text.length} characters`);
  assert.match(text, /Never use a blocking question tool/);
});
