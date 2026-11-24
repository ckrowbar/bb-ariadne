// Host git and GitHub API operations. Assumes the BB server and project
// checkout share a machine, so git/check commands run via node:child_process.
//
// Why HTTPS: BB refreshes a worktree base with `git fetch origin`, which goes
// over SSH. On a Datadog workspace SSH only works while the user's laptop
// forwards its agent. A ddtool token over HTTPS works unattended, and also
// powers zero-token external PR watches without LLM bash loops.
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExternalPrState, GitHubPrRef } from "./watches.ts";

const run = promisify(execFile);
const DDTOOL_CANDIDATES = ["ddtool", "/opt/dogbrew/bin/ddtool"];

async function git(repoPath: string, args: string[], env?: NodeJS.ProcessEnv, timeoutMs = 120_000) {
  const { stdout } = await run("git", ["-C", repoPath, ...args], {
    env: { ...process.env, ...env },
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

async function gitOk(repoPath: string, args: string[]): Promise<boolean> {
  try {
    await git(repoPath, args);
    return true;
  } catch {
    return false;
  }
}

/** "git@ddoghq.github.com:ddoghq/dd-source.git" -> { owner: "ddoghq", repo: "dd-source" } */
export function parseGitHubRemote(url: string | null): { owner: string; repo: string } | null {
  if (url === null) return null;
  const match = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match === null ? null : { owner: match[1]!, repo: match[2]! };
}

/**
 * A GitHub token for `org`: ddtool for Datadog orgs, then the user's stored gh
 * credentials (personal repos such as this plugin's). GH_TOKEN/GITHUB_TOKEN
 * are dropped so workspace-injected tokens cannot pick the wrong account.
 */
async function githubToken(org: string): Promise<string> {
  const errors: string[] = [];
  for (const command of DDTOOL_CANDIDATES) {
    try {
      const { stdout } = await run(command, ["auth", "github", "token", "--org", org], { timeout: 30_000 });
      if (stdout.trim() !== "") return stdout.trim();
    } catch (error) {
      errors.push(String(error).split("\n")[0]!);
    }
  }
  try {
    const { GH_TOKEN: _gh, GITHUB_TOKEN: _github, ...env } = process.env;
    const { stdout } = await run("gh", ["auth", "token"], { timeout: 30_000, env });
    if (stdout.trim() !== "") return stdout.trim();
  } catch (error) {
    errors.push(String(error).split("\n")[0]!);
  }
  throw new Error(`no GitHub token for ${org}: ${errors.join("; ")}`);
}

export interface BaseRefresh {
  sha: string;
  fresh: boolean;
  warning: string | null;
}

/**
 * Fetches `branch` from GitHub over HTTPS into refs/remotes/origin/<branch>
 * and returns its commit. Falls back to the existing local ref, marked stale,
 * when the fetch fails. The token only lives in the child's environment.
 */
export async function refreshBase(repoPath: string, remoteUrl: string | null, branch: string): Promise<BaseRefresh> {
  const localRef = `refs/remotes/origin/${branch}`;
  const remote = parseGitHubRemote(remoteUrl);
  let warning: string | null = null;
  if (remote === null) {
    warning = `cannot parse GitHub remote ${remoteUrl ?? "(none)"}`;
  } else {
    const dir = await mkdtemp(join(tmpdir(), "ariadne-askpass-"));
    const askpass = join(dir, "askpass.sh");
    try {
      const token = await githubToken(remote.owner);
      await writeFile(
        askpass,
        '#!/bin/sh\ncase "$1" in *sername*) echo x-access-token ;; *) printf \'%s\\n\' "$ARIADNE_GH_TOKEN" ;; esac\n',
      );
      await chmod(askpass, 0o700);
      await git(
        repoPath,
        [
          "-c",
          "credential.helper=",
          "fetch",
          "--quiet",
          "--no-tags",
          // The https:: helper syntax bypasses the user's https -> SSH insteadOf rules.
          `https::https://github.com/${remote.owner}/${remote.repo}.git`,
          `+refs/heads/${branch}:${localRef}`,
        ],
        {
          ARIADNE_GH_TOKEN: token,
          GIT_ASKPASS: askpass,
          GIT_ASKPASS_REQUIRE: "force",
          GIT_TERMINAL_PROMPT: "0",
          GIT_ALLOW_PROTOCOL: "https",
        },
      );
    } catch (error) {
      warning = `fetch failed, using local ${localRef}: ${String(error).replace(/gh[pousr]_[A-Za-z0-9_]+/g, "***").slice(0, 300)}`;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const sha = await git(repoPath, ["rev-parse", "--verify", localRef]);
  return { sha, fresh: warning === null, warning };
}

/**
 * Fetches an external PR's merge and check-runs state via GitHub REST API
 * using the same org-scoped token path as refreshBase.
 */
export async function fetchGitHubPr(ref: GitHubPrRef): Promise<ExternalPrState> {
  const token = await githubToken(ref.owner);
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "bb-plugin-ariadne",
  };
  const prRes = await fetch(`https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`, {
    headers,
    signal: AbortSignal.timeout(20_000),
  });
  if (!prRes.ok) {
    throw new Error(`GitHub PR ${ref.owner}/${ref.repo}#${ref.number} returned HTTP ${prRes.status}`);
  }
  const prJson = (await prRes.json()) as {
    number: number;
    html_url: string;
    state: string;
    merged: boolean;
    head?: { sha?: string };
  };
  const state: ExternalPrState["state"] = prJson.merged ? "merged" : prJson.state === "closed" ? "closed" : "open";
  let passedCount = 0;
  let failedCount = 0;
  let pendingCount = 0;
  let checksState: ExternalPrState["checksState"] = "unknown";

  const sha = prJson.head?.sha;
  if (typeof sha === "string" && sha !== "") {
    const checksRes = await fetch(
      `https://api.github.com/repos/${ref.owner}/${ref.repo}/commits/${sha}/check-runs?per_page=100`,
      { headers, signal: AbortSignal.timeout(20_000) },
    );
    if (checksRes.ok) {
      const checksJson = (await checksRes.json()) as {
        check_runs?: { status?: string; conclusion?: string | null }[];
      };
      const runs = checksJson.check_runs ?? [];
      for (const r of runs) {
        if (r.status !== "completed") {
          pendingCount++;
        } else if (r.conclusion === "success" || r.conclusion === "neutral" || r.conclusion === "skipped") {
          passedCount++;
        } else {
          failedCount++;
        }
      }
      if (runs.length === 0) checksState = "no_checks";
      else if (failedCount > 0) checksState = "failing";
      else if (pendingCount > 0) checksState = "pending";
      else checksState = "passing";
    }
  }

  return {
    number: prJson.number,
    url: prJson.html_url,
    state,
    checksState,
    failedCount,
    pendingCount,
    passedCount,
  };
}

/** Runs a bounded shell condition check for a `command` watch (exit 0 = ready). */
export async function runCheckCommand(
  cwd: string,
  command: string,
  timeoutMs = 30_000,
): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await run("/bin/sh", ["-lc", command], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 256 * 1024,
    });
    return { ok: true, output: (stdout || stderr).trim().slice(0, 1000) };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const text = (err.stdout || err.stderr || err.message || "failed").trim().slice(0, 400);
    return { ok: false, output: text };
  }
}

/** The checkout's origin URL. BB records a project's remote once, so it goes stale after a repo rename. */
export async function originUrl(repoPath: string): Promise<string | null> {
  try {
    return await git(repoPath, ["remote", "get-url", "origin"]);
  } catch {
    return null;
  }
}

export async function defaultBranch(repoPath: string): Promise<string> {
  try {
    const ref = await git(repoPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    return ref.replace(/^origin\//, "");
  } catch {
    return "main";
  }
}

/**
 * True when every commit on `branch` already exists upstream: in its tracking
 * branch, in origin/<branch>, or in the base ref. Such a branch can be
 * deleted without losing work.
 */
export async function branchIsSafeToDelete(repoPath: string, branch: string, baseRef: string): Promise<boolean> {
  const candidates = [`${branch}@{upstream}`, `refs/remotes/origin/${branch}`, baseRef];
  for (const candidate of candidates) {
    if (!(await gitOk(repoPath, ["rev-parse", "--verify", "--quiet", candidate]))) continue;
    if (await gitOk(repoPath, ["merge-base", "--is-ancestor", `refs/heads/${branch}`, candidate])) return true;
  }
  return false;
}

export async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  return gitOk(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
}

export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  await git(repoPath, ["branch", "-D", branch]);
}

/** Uncommitted changes in a worktree, or null when it is clean. */
export async function worktreeDirt(worktreePath: string): Promise<string | null> {
  const status = await git(worktreePath, ["status", "--porcelain"], undefined, 300_000);
  return status === "" ? null : status.split("\n").slice(0, 5).join("\n");
}

export async function currentBranch(worktreePath: string): Promise<string | null> {
  try {
    const name = await git(worktreePath, ["branch", "--show-current"]);
    return name === "" ? null : name;
  } catch {
    return null;
  }
}
