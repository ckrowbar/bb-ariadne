import assert from "node:assert/strict";
import { test } from "node:test";
import { workstreamFromSubPath } from "./route.ts";

test("subPath decodes to the workstream name", () => {
  const cases: [string, string | null][] = [
    ["", null],
    ["ariadne-improve", "ariadne-improve"],
    // BB encodes the plain name once: "ariadne self improvement".
    ["ariadne%20self%20improvement", "ariadne self improvement"],
    ["q4%2F50%25", "q4/50%"],
    // A malformed escape falls back to the raw subPath instead of throwing.
    ["50%", "50%"],
  ];
  for (const [subPath, name] of cases) assert.equal(workstreamFromSubPath(subPath), name, subPath);
});
