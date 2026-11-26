import assert from "node:assert/strict";
import { test } from "node:test";
import { githubToken, parseGitHubRemote } from "./git.ts";

test("parseGitHubRemote parses SSH and HTTPS URLs", () => {
  assert.deepEqual(parseGitHubRemote("git@github.com:acme/app.git"), { owner: "acme", repo: "app" });
  assert.deepEqual(parseGitHubRemote("https://github.com/acme/app"), { owner: "acme", repo: "app" });
  assert.equal(parseGitHubRemote(null), null);
});

test("githubToken runs configured tokenCommand with org substitution and rejects unsafe org names", async () => {
  const token = await githubToken("acme-org", "printf 'tok-%s-%s' '{org}' \"$ARIADNE_GITHUB_ORG\"");
  assert.equal(token, "tok-acme-org-acme-org");

  await assert.rejects(
    () => githubToken("acme;echo pwned", "echo should-not-run"),
    /invalid GitHub org name/,
  );
});
