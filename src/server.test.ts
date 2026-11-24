import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createFakePluginHost,
  experimental_scanPublicSdkOnly,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function makeHarness(overrides?: {
  settings?: Record<string, unknown>;
  prByEnv?: Map<string, Record<string, unknown>>;
  contextTokensByThread?: Map<string, number>;
  diffFilesByEnv?: Map<string, { path: string; changeKind: "modified"; additions: number; deletions: number }[]>;
}) {
  let threadSeq = 1;
  let envSeq = 1;
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const prByEnv = overrides?.prByEnv ?? new Map<string, Record<string, unknown>>();
  const contextTokensByThread = overrides?.contextTokensByThread ?? new Map<string, number>();
  const diffFilesByEnv = overrides?.diffFilesByEnv ?? new Map<string, { path: string; changeKind: "modified"; additions: number; deletions: number }[]>();
  const envs = new Map<string, Record<string, unknown>>();

  const { bb, harness } = createFakePluginHost({
    pluginId: "ariadne",
    agentSkillIds: ["ariadne-orchestrate"],
    settings: {
      maxConcurrentWorkers: 2,
      reconcileSeconds: 60,
      autoReactCi: true,
      autoReactConflicts: true,
      autoReactReviews: false,
      maxReactionRetries: 2,
      verifyByDefault: true,
      maxVerifyRetries: 1,
      workerRotateTokens: 160_000,
      managerCompactTokens: 140_000,
      stuckMinutes: 30,
      dormantMinutes: 60,
      ...(overrides?.settings ?? {}),
    },
    sdk: {
      projects: {
        get: async ({ projectId }: { projectId: string }) => ({
          id: projectId,
          name: "personal-test",
          kind: "personal",
          gitRemoteUrl: null,
          sources: [],
        }),
        list: async () => [{ id: "proj_p", name: "personal-test", kind: "personal", sources: [] }],
      },
      providers: {
        list: async () => [
          {
            id: "claude-code",
            displayName: "Claude Code",
            available: true,
            capabilities: {},
            maintenance: { health: false, installation: false, usage: false },
            pluginId: "provider-claude-code",
            logoUrl: null,
          },
        ],
        models: async (args) => ({
          providerId: args?.providerId ?? "claude-code",
          models: [
            {
              id: "claude-opus-5-5",
              model: "claude-opus-5-5",
              displayName: "Opus 5.5",
              description: "Most capable",
              isDefault: false,
              supportedReasoningEfforts: [
                { reasoningEffort: "medium", description: "Medium" },
                { reasoningEffort: "high", description: "High" },
              ],
            },
            {
              id: "claude-sonnet-5-5",
              model: "claude-sonnet-5-5",
              displayName: "Sonnet 5.5",
              description: "Fast & capable",
              isDefault: true,
              supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }],
            },
          ],
          selectedOnlyModels: [],
        }),
      },
      threads: {
        spawn: async (args) => {
          const id = `thr_${threadSeq++}`;
          const envArg = args.environment as { type?: string; environmentId?: string } | undefined;
          const environmentId = envArg?.type === "reuse" && envArg.environmentId ? envArg.environmentId : `env_${envSeq++}`;
          if (!envs.has(environmentId)) {
            envs.set(environmentId, {
              id: environmentId,
              managed: true,
              isWorktree: true,
              projectId: args.projectId,
              path: null,
              branchName: `bb/${id}`,
              defaultBranch: "main",
              lifecycle: { phase: "active", retireAt: null },
            });
          }
          const t = makeThreadResponse({
            id,
            projectId: String(args.projectId ?? "proj_p"),
            environmentId,
            title: String(args.title ?? id),
            parentThreadId: typeof args.parentThreadId === "string" ? args.parentThreadId : null,
            originPluginId: "ariadne",
            status: "idle",
            visibility: args.visibility ?? "visible",
          });
          threads.set(id, t);
          return t;
        },
        list: async (args?: { parentThreadId?: string; archived?: boolean }) => {
          return [...threads.values()].filter((t) => {
            if (args?.parentThreadId !== undefined && t.parentThreadId !== args.parentThreadId) return false;
            if (args?.archived === false && t.archivedAt !== null) return false;
            return t.deletedAt === null;
          });
        },
        get: async ({ threadId }: { threadId: string }) => {
          const t = threads.get(threadId);
          if (!t) throw new Error(`404 thread ${threadId} not found`);
          return t;
        },
        update: async (args: { threadId: string; title?: string | null; parentThreadId?: string | null; model?: string | null; reasoningLevel?: string | null }) => {
          const t = threads.get(args.threadId);
          if (!t) throw new Error(`404 thread ${args.threadId} not found`);
          const next = {
            ...t,
            ...(args.title !== undefined ? { title: args.title } : {}),
            ...(args.parentThreadId !== undefined ? { parentThreadId: args.parentThreadId } : {}),
          };
          threads.set(args.threadId, next);
          return { ok: true };
        },
        pin: async ({ threadId }: { threadId: string }) => {
          const t = threads.get(threadId);
          if (t) threads.set(threadId, { ...t, pinnedAt: Date.now() });
          return { ok: true };
        },
        unpin: async ({ threadId }: { threadId: string }) => {
          const t = threads.get(threadId);
          if (t) threads.set(threadId, { ...t, pinnedAt: null });
          return { ok: true };
        },
        defaultExecutionOptions: async () => ({
          providerId: "claude-code",
          model: "claude-sonnet-5-5",
          reasoningLevel: "medium",
          permissionMode: "full",
          serviceTier: "default",
        }),
        updatePluginMetadata: async () => ({}),
        clearContext: async () => ({ ok: true }),
        interactions: {
          list: async () => [],
        },
        send: async () => ({ delivery: "sent" }),
        archive: async ({ threadId }: { threadId: string }) => {
          const t = threads.get(threadId);
          if (t) threads.set(threadId, { ...t, archivedAt: Date.now() });
          return { ok: true };
        },
        stop: async () => ({ ok: true }),
        compact: async () => ({ ok: true }),
        output: async () => ({ output: "worker output summary" }),
        context: async ({ threadId }: { threadId: string }) => {
          const used = contextTokensByThread.get(threadId);
          return {
            usage: used === undefined ? null : { estimated: false, modelContextWindow: 1_000_000, usedTokens: used },
          };
        },
      },
      environments: {
        get: async ({ environmentId }: { environmentId: string }) => {
          return (
            envs.get(environmentId) ?? {
              id: environmentId,
              managed: true,
              isWorktree: true,
              projectId: "proj_p",
              path: null,
              branchName: "main",
              defaultBranch: "main",
              lifecycle: { phase: "active", retireAt: null },
            }
          );
        },
        pullRequest: async ({ environmentId }: { environmentId: string }) => {
          const pr = prByEnv.get(environmentId);
          return pr ? { outcome: "available", pullRequest: pr } : { outcome: "absent" };
        },
        diffFiles: async ({ environmentId }: { environmentId: string }) => {
          const files = diffFilesByEnv.get(environmentId) ?? [];
          return {
            outcome: "available",
            files: files.map((f) => ({
              ...f,
              binary: false,
              loadMode: "auto",
              origin: "tracked",
              previousPath: null,
            })),
            initialPatches: [],
            mergeBaseRef: "main",
            shortstat: files.length > 0 ? `${files.length} files changed` : "",
            truncated: false,
          };
        },
        status: async () => ({ outcome: "unavailable", message: "none" }),
      },
    },
  });

  return { bb, harness, threads, prByEnv, contextTokensByThread, diffFilesByEnv };
}

test("queued dependencies dispatch automatically when upstream completes and preserve sidebar nesting", async () => {
  const { bb, harness } = makeHarness();
  await plugin(bb);

  const { ariadneThreadId } = (await harness.behavior.callRpc("workstream_create", {
    name: "stack",
    projectId: "proj_p",
    links: [],
  })) as { ariadneThreadId: string };

  const res1 = await harness.behavior.callAgentTool(
    "ariadne_spawn_worker",
    { title: "Part 1", prompt: "Build part 1", verifyMode: "off" },
    { threadId: ariadneThreadId },
  );
  const task1Id = /task (t_[a-z0-9]+)/.exec(String(res1))![1]!;

  // Part 2 depends on Part 1 -> queued until Part 1 finishes.
  const res2 = await harness.behavior.callAgentTool(
    "ariadne_spawn_worker",
    { title: "Part 2", prompt: "Build part 2", dependsOn: [task1Id], verifyMode: "off" },
    { threadId: ariadneThreadId },
  );
  assert.match(String(res2), /Queued task/);

  let board = (await harness.behavior.callRpc("board", { workstream: "stack" })) as { tasks: { id: string; status: string; workerThreadId: string | null }[] };
  const t1 = board.tasks.find((t) => t.id === task1Id)!;
  const t2 = board.tasks.find((t) => t.id !== task1Id)!;
  assert.equal(t1.status, "running");
  assert.equal(t2.status, "queued");
  assert.equal(t2.workerThreadId, null);

  // Verify nested parentThreadId on Part 1 worker.
  const spawns = harness.inspection.sdk.callsTo("threads.spawn");
  const worker1Spawn = spawns[1]![0] as { parentThreadId?: string };
  assert.equal(worker1Spawn.parentThreadId, ariadneThreadId);

  // Part 1 reports done -> reconciler automatically dispatches Part 2 nested under Ariadne.
  await harness.behavior.callAgentTool(
    "ariadne_report",
    { status: "done", note: "Part 1 finished" },
    { threadId: t1.workerThreadId! },
  );
  await harness.behavior.runCli(["reconcile"]);

  board = (await harness.behavior.callRpc("board", { workstream: "stack" })) as { tasks: { id: string; status: string; workerThreadId: string | null }[] };
  const t2After = board.tasks.find((t) => t.id === t2.id)!;
  assert.equal(t2After.status, "running");
  assert.ok(t2After.workerThreadId !== null);
  const worker2Spawn = harness.inspection.sdk.callsTo("threads.spawn")[2]![0] as { parentThreadId?: string };
  assert.equal(worker2Spawn.parentThreadId, ariadneThreadId);

  await harness.lifecycle.dispose();
});

test("clean-context hidden verifier loops failure back to worker and passes to in-review without parentThreadId", async () => {
  const { bb, harness, diffFilesByEnv } = makeHarness();
  await plugin(bb);

  const { ariadneThreadId } = (await harness.behavior.callRpc("workstream_create", {
    name: "qa",
    projectId: "proj_p",
    links: [],
  })) as { ariadneThreadId: string };

  await harness.behavior.callAgentTool(
    "ariadne_spawn_worker",
    { title: "Feature X", prompt: "Implement X" },
    { threadId: ariadneThreadId },
  );
  const board0 = (await harness.behavior.callRpc("board", { workstream: "qa" })) as {
    tasks: { id: string; workerThreadId: string; environmentId: string }[];
  };
  const task = board0.tasks[0]!;
  diffFilesByEnv.set(task.environmentId, [{ path: "src/x.ts", changeKind: "modified", additions: 10, deletions: 2 }]);

  // Worker opens PR and reports done -> triggers hidden clean-context verifier reusing environmentId.
  await harness.behavior.callAgentTool(
    "ariadne_report",
    { status: "pr-opened", note: "Opened draft PR", prUrl: "https://github.com/o/r/pull/10" },
    { threadId: task.workerThreadId },
  );
  const doneReply = await harness.behavior.callAgentTool(
    "ariadne_report",
    { status: "done", note: "Implemented X and tests pass" },
    { threadId: task.workerThreadId },
  );
  assert.match(String(doneReply), /clean-context verification/);

  const verifierSpawn = harness.inspection.sdk.callsTo("threads.spawn")[2]![0] as {
    visibility?: string;
    parentThreadId?: string;
    environment?: { type: string; environmentId: string };
  };
  assert.equal(verifierSpawn.visibility, "hidden");
  assert.equal(verifierSpawn.parentThreadId, undefined, "verifier stays detached from parentThreadId");
  assert.deepEqual(verifierSpawn.environment, { type: "reuse", environmentId: task.environmentId });

  const boardVerifying = (await harness.behavior.callRpc("board", { workstream: "qa" })) as {
    tasks: { id: string; status: string; runs: { role: string; threadId: string; status: string }[] }[];
  };
  assert.equal(boardVerifying.tasks[0]!.status, "verifying");
  const verifier1 = boardVerifying.tasks[0]!.runs.find((r) => r.role === "verifier")!;

  // Verifier configure() receives only ariadne_verify_verdict.
  const cfg = await harness.behavior.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({
      thread: { id: verifier1.threadId },
      pluginMetadata: { role: "verifier", taskId: task.id, workstream: "qa" },
    }),
  );
  assert.deepEqual(
    cfg.tools.map((t) => t.name),
    ["ariadne_verify_verdict"],
  );

  // Reconciling immediately after spawn must NOT prematurely fail a freshly spawned verifier.
  await harness.behavior.runCli(["reconcile"]);
  const boardStillVerifying = (await harness.behavior.callRpc("board", { workstream: "qa" })) as {
    tasks: { id: string; status: string; runs: { role: string; threadId: string; status: string }[] }[];
  };
  assert.equal(boardStillVerifying.tasks[0]!.status, "verifying");

  // Verifier rejects -> findings route back to worker; tool call must NOT call threads.stop mid-turn.
  const stopsBeforeVerdict = harness.inspection.sdk.callsTo("threads.stop").length;
  await harness.behavior.callAgentTool(
    "ariadne_verify_verdict",
    { verdict: "fail", summary: "Missing null check", issues: ["src/x.ts:12 panics on null"] },
    { threadId: verifier1.threadId },
  );
  assert.equal(harness.inspection.sdk.callsTo("threads.stop").length, stopsBeforeVerdict, "must not abort verifier mid-tool-call");
  await harness.behavior.emitThreadEvent("thread.idle", {
    thread: makeThreadResponse({ id: verifier1.threadId, originPluginId: "ariadne", visibility: "hidden" }),
    lastAssistantText: null,
  });
  assert.ok(
    harness.inspection.sdk.callsTo("threads.archive").some((c) => (c[0] as { threadId: string }).threadId === verifier1.threadId),
    "settled verifier archives cleanly on thread.idle",
  );
  let boardAfterFail = (await harness.behavior.callRpc("board", { workstream: "qa" })) as {
    tasks: { status: string; runs: { threadId: string; status: string }[] }[];
  };
  assert.equal(boardAfterFail.tasks[0]!.status, "running");
  assert.equal(boardAfterFail.tasks[0]!.runs.find((r) => r.threadId === verifier1.threadId)?.status, "rejected");

  // Worker fixes and reports done again -> second verifier passes -> task moves to in-review.
  await harness.behavior.callAgentTool(
    "ariadne_report",
    { status: "done", note: "Fixed null check" },
    { threadId: task.workerThreadId },
  );
  const boardVerifying2 = (await harness.behavior.callRpc("board", { workstream: "qa" })) as {
    tasks: { runs: { role: string; threadId: string; status: string }[] }[];
  };
  const verifier2 = boardVerifying2.tasks[0]!.runs.find((r) => r.role === "verifier" && r.status === "running")!;
  await harness.behavior.callAgentTool(
    "ariadne_verify_verdict",
    { verdict: "pass", summary: "Diff and tests verified", checksRun: "npm test" },
    { threadId: verifier2.threadId },
  );
  const boardPassed = (await harness.behavior.callRpc("board", { workstream: "qa" })) as {
    tasks: { status: string; runs: { threadId: string; status: string }[] }[];
  };
  assert.equal(boardPassed.tasks[0]!.status, "in-review");
  assert.equal(boardPassed.tasks[0]!.runs.find((r) => r.threadId === verifier2.threadId)?.status, "passed");

  await harness.lifecycle.dispose();
});

test("durable timer watch parks worker in waiting and wakes it on reconcile; rotation preserves worktree", async () => {
  const { bb, harness, contextTokensByThread, threads } = makeHarness();
  await plugin(bb);

  const { ariadneThreadId } = (await harness.behavior.callRpc("workstream_create", {
    name: "ops",
    projectId: "proj_p",
    links: [],
  })) as { ariadneThreadId: string };

  await harness.behavior.callAgentTool(
    "ariadne_spawn_worker",
    { title: "Wait & rotate", prompt: "Deploy and check", verifyMode: "off" },
    { threadId: ariadneThreadId },
  );
  const board0 = (await harness.behavior.callRpc("board", { workstream: "ops" })) as {
    tasks: { id: string; workerThreadId: string; environmentId: string }[];
  };
  const task = board0.tasks[0]!;
  const origWorker = task.workerThreadId;

  // Worker registers an already-due timer watch -> moves to waiting.
  await harness.behavior.callAgentTool(
    "ariadne_watch",
    { kind: "timer", target: String(Date.now() - 1000), resumePrompt: "Verify rollout metrics" },
    { threadId: origWorker },
  );
  let board = (await harness.behavior.callRpc("board", { workstream: "ops" })) as {
    tasks: { status: string; workerThreadId: string; watches: { id: string; status: string }[]; runs: { threadId: string; status: string }[] }[];
  };
  assert.equal(board.tasks[0]!.status, "waiting");
  assert.equal(board.tasks[0]!.watches[0]!.status, "active");

  // Simulate high worker context (180k >= 160k) -> triggering watch rotates to a fresh nested run on the same worktree!
  contextTokensByThread.set(origWorker, 180_000);
  await harness.behavior.runCli(["reconcile"]);

  board = (await harness.behavior.callRpc("board", { workstream: "ops" })) as {
    tasks: { status: string; workerThreadId: string; watches: { id: string; status: string }[]; runs: { threadId: string; status: string }[] }[];
  };
  assert.equal(board.tasks[0]!.status, "running");
  assert.equal(board.tasks[0]!.watches[0]!.status, "triggered");
  assert.notEqual(board.tasks[0]!.workerThreadId, origWorker, "rotated to fresh worker thread");
  assert.equal(board.tasks[0]!.runs.find((r) => r.threadId === origWorker)?.status, "superseded");

  // Emitting thread.archived for the superseded worker MUST NOT drop the task!
  await harness.behavior.emitThreadEvent("thread.archived", {
    thread: threads.get(origWorker)!,
  });
  board = (await harness.behavior.callRpc("board", { workstream: "ops" })) as {
    tasks: { status: string; workerThreadId: string; watches: { id: string; status: string }[]; runs: { threadId: string; status: string }[] }[];
  };
  assert.equal(board.tasks[0]!.status, "running");

  // Cancelling the last active watch on a waiting task moves it out of waiting into blocked.
  const activeWorker = board.tasks[0]!.workerThreadId;
  await harness.behavior.callAgentTool(
    "ariadne_watch",
    { kind: "timer", target: "2h", resumePrompt: "Check later" },
    { threadId: activeWorker },
  );
  board = (await harness.behavior.callRpc("board", { workstream: "ops" })) as {
    tasks: { status: string; workerThreadId: string; watches: { id: string; status: string }[]; runs: { threadId: string; status: string }[] }[];
  };
  const pendingWatch = board.tasks[0]!.watches.find((w) => w.status === "active")!;
  assert.equal(board.tasks[0]!.status, "waiting");
  await harness.behavior.callRpc("watch_cancel", { watchId: pendingWatch.id });
  board = (await harness.behavior.callRpc("board", { workstream: "ops" })) as {
    tasks: { status: string; workerThreadId: string; watches: { id: string; status: string }[]; runs: { threadId: string; status: string }[] }[];
  };
  assert.equal(board.tasks[0]!.status, "blocked");

  await harness.lifecycle.dispose();
});

test("CI failure auto-fixes up to maxReactionRetries then escalates, and heavy idle manager auto-compacts", async () => {
  const prByEnv = new Map<string, Record<string, unknown>>();
  const contextTokensByThread = new Map<string, number>();
  const { bb, harness } = makeHarness({
    settings: { maxReactionRetries: 1, managerCompactTokens: 140_000 },
    prByEnv,
    contextTokensByThread,
  });
  await plugin(bb);

  const { ariadneThreadId } = (await harness.behavior.callRpc("workstream_create", {
    name: "ci",
    projectId: "proj_p",
    links: [],
  })) as { ariadneThreadId: string };

  await harness.behavior.callAgentTool(
    "ariadne_spawn_worker",
    { title: "Fix bug", prompt: "Fix it", verifyMode: "off" },
    { threadId: ariadneThreadId },
  );
  const board0 = (await harness.behavior.callRpc("board", { workstream: "ci" })) as {
    tasks: { id: string; workerThreadId: string; environmentId: string }[];
  };
  const task = board0.tasks[0]!;

  // First failing CI observation -> auto-steers worker (attempt 1/1).
  prByEnv.set(task.environmentId, {
    number: 99,
    title: "Fix bug",
    url: "https://github.com/o/r/pull/99",
    state: "open",
    attention: "checks_failed",
    checks: { state: "failing", passedCount: 1, failedCount: 1, pendingCount: 0, totalCount: 2 },
    updatedAt: "2026-11-24T10:00:00Z",
    review: { state: "none", reviewRequestCount: 0 },
    mergeability: { state: "mergeable", mergeable: "MERGEABLE", mergeStateStatus: "UNSTABLE" },
    autoMerge: false,
    baseRefName: "main",
    headRefName: "fix",
    inMergeQueue: false,
  });
  contextTokensByThread.set(ariadneThreadId, 150_000);

  await harness.behavior.runCli(["reconcile"]);
  const sendsAfterFirst = harness.inspection.sdk.callsTo("threads.send");
  assert.ok(
    sendsAfterFirst.some((c) => (c[0] as { threadId: string }).threadId === task.workerThreadId),
    "worker should be auto-steered on first CI failure",
  );
  assert.equal(harness.inspection.sdk.callsTo("threads.compact").length, 1, "heavy idle manager auto-compacted");

  // Second distinct failing CI run (budget 1/1 exhausted) -> escalates to Ariadne instead of steering worker again.
  prByEnv.set(task.environmentId, {
    ...prByEnv.get(task.environmentId)!,
    updatedAt: "2026-11-24T10:15:00Z",
  });
  const sendsBeforeSecond = harness.inspection.sdk.callsTo("threads.send").length;
  await harness.behavior.runCli(["reconcile"]);
  const newSends = harness.inspection.sdk.callsTo("threads.send").slice(sendsBeforeSecond);
  assert.ok(
    newSends.some((c) => (c[0] as { threadId: string }).threadId === ariadneThreadId),
    "Ariadne should receive escalation once retry cap is reached",
  );
  assert.ok(
    !newSends.some((c) => (c[0] as { threadId: string }).threadId === task.workerThreadId),
    "worker must not be steered past maxReactionRetries",
  );

  await harness.lifecycle.dispose();
});

test("Ariadne controls its own session, model, compaction, defaults and live settings via ariadne_session", async () => {
  const { bb, harness, threads } = makeHarness();
  await plugin(bb);

  const { ariadneThreadId } = (await harness.behavior.callRpc("workstream_create", {
    name: "self-ctrl",
    projectId: "proj_p",
    links: [],
  })) as { ariadneThreadId: string };

  const modelsOut = String(
    await harness.behavior.callAgentTool("ariadne_session", { action: "models" }, { threadId: ariadneThreadId }),
  );
  assert.match(modelsOut, /claude-opus-5-5/);

  await harness.behavior.callAgentTool(
    "ariadne_session",
    { action: "update", model: "claude-opus-5-5", reasoningLevel: "high", title: "Renamed stream", pinned: false },
    { threadId: ariadneThreadId },
  );
  const updateCall = harness.inspection.sdk.callsTo("threads.update").at(-1)?.[0] as {
    threadId: string;
    model?: string;
    reasoningLevel?: string;
    title?: string;
  };
  assert.equal(updateCall.threadId, ariadneThreadId);
  assert.equal(updateCall.model, "claude-opus-5-5");
  assert.equal(updateCall.reasoningLevel, "high");
  assert.equal(updateCall.title, "🧶 Renamed stream");
  assert.equal(harness.inspection.sdk.callsTo("threads.unpin").length, 1);

  // Self-compact defers until thread.idle so Ariadne never interrupts its own turn.
  const compactsBefore = harness.inspection.sdk.callsTo("threads.compact").length;
  await harness.behavior.callAgentTool("ariadne_session", { action: "compact" }, { threadId: ariadneThreadId });
  assert.equal(harness.inspection.sdk.callsTo("threads.compact").length, compactsBefore);
  await harness.behavior.emitThreadEvent("thread.idle", {
    thread: threads.get(ariadneThreadId)!,
    lastAssistantText: "Compacting now.",
  });
  assert.equal(harness.inspection.sdk.callsTo("threads.compact").length, compactsBefore + 1);

  // Update workstream worker defaults, links, and live orchestrator config.
  await harness.behavior.callAgentTool(
    "ariadne_session",
    {
      action: "set-defaults",
      workerModel: "claude-opus-5-5",
      workerReasoningLevel: "high",
      addLinks: ["https://jira.example/CHAT-1"],
    },
    { threadId: ariadneThreadId },
  );
  await harness.behavior.callAgentTool(
    "ariadne_session",
    { action: "set-config", configPatch: { maxConcurrentWorkers: 5, verifyByDefault: false } },
    { threadId: ariadneThreadId },
  );
  const statusOut = String(
    await harness.behavior.callAgentTool("ariadne_session", { action: "status" }, { threadId: ariadneThreadId }),
  );
  assert.match(statusOut, /maxConcurrentWorkers=5/);
  assert.match(statusOut, /verifyByDefault=false/);
  assert.match(statusOut, /https:\/\/jira\.example\/CHAT-1/);

  await harness.lifecycle.dispose();
});

test("normal thread adopts into Ariadne via skill+CLI, reloads on idle, and threads move into and out of Ariadne", async () => {
  const { bb, harness, threads } = makeHarness();
  await plugin(bb);

  // Normal standalone thread gets the ariadne-orchestrate skill; side-chat forks do not.
  const normalThread = makeThreadResponse({
    id: "thr_norm",
    projectId: "proj_p",
    environmentId: "env_norm",
    title: "Investigate auth bug",
    parentThreadId: null,
    originPluginId: null,
    status: "active",
    visibility: "visible",
  });
  const existingChild = makeThreadResponse({
    id: "thr_child0",
    projectId: "proj_p",
    environmentId: "env_child0",
    title: "Existing helper thread",
    parentThreadId: "thr_norm",
    originPluginId: null,
    status: "idle",
    visibility: "visible",
  });
  const sideThread = makeThreadResponse({
    id: "thr_side",
    projectId: "proj_p",
    environmentId: "env_side",
    title: "Standalone investigation",
    parentThreadId: null,
    originPluginId: null,
    status: "idle",
    visibility: "visible",
  });
  threads.set(normalThread.id, normalThread);
  threads.set(existingChild.id, existingChild);
  threads.set(sideThread.id, sideThread);

  const normalCfg = await harness.behavior.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({ thread: { id: normalThread.id } }),
  );
  assert.deepEqual(normalCfg.skills, ["ariadne-orchestrate"]);
  assert.deepEqual(normalCfg.tools, []);

  const forkCfg = await harness.behavior.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({
      thread: { id: "thr_fork" },
      origin: { kind: "fork", pluginId: "side-chat" },
    }),
  );
  assert.deepEqual(forkCfg.skills, []);

  // Adopt normalThread via CLI with --continue (simulating agent following ariadne-orchestrate skill).
  const adoptRes = await harness.behavior.runCli(
    ["adopt", "auth-bug", "--continue", "Split this into PRs"],
    { threadId: normalThread.id, projectId: "proj_p" },
  );
  assert.equal(adoptRes.exitCode, 0);
  assert.match(adoptRes.stdout ?? "", /Adopted thr_norm as Ariadne workstream "auth-bug"/);
  assert.match(adoptRes.stdout ?? "", /Adopted 1 existing child thread/);
  assert.equal(threads.get(normalThread.id)?.title, "🧶 Investigate auth bug");

  // Once normalThread ends its turn, thread.idle reloads its runtime (stop) and sends the --continue wake!
  const stopsBefore = harness.inspection.sdk.callsTo("threads.stop").length;
  const sendsBefore = harness.inspection.sdk.callsTo("threads.send").length;
  await harness.behavior.emitThreadEvent("thread.idle", {
    thread: { ...threads.get(normalThread.id)!, status: "idle" },
    lastAssistantText: "Switching to Ariadne now.",
  });
  assert.ok(
    harness.inspection.sdk
      .callsTo("threads.stop")
      .slice(stopsBefore)
      .some((c) => (c[0] as { threadId: string }).threadId === normalThread.id),
    "idle handler releases runtime so new tools take effect",
  );
  assert.ok(
    harness.inspection.sdk
      .callsTo("threads.send")
      .slice(sendsBefore)
      .some((c) => (c[0] as { threadId: string }).threadId === normalThread.id),
    "idle handler delivers --continue wake after reload",
  );

  // Adopted Ariadne thread now receives full Ariadne tools from configure().
  const adoptedCfg = await harness.behavior.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({ thread: { id: normalThread.id } }),
  );
  assert.ok(adoptedCfg.tools.some((t) => t.name === "ariadne_session"));
  assert.ok(adoptedCfg.tools.some((t) => t.name === "ariadne_adopt_worker"));

  // Dragging a standalone thread UNDER Ariadne in BB sidebar (parentThreadId = normalThread.id) auto-adopts it!
  threads.set(sideThread.id, { ...threads.get(sideThread.id)!, parentThreadId: normalThread.id });
  await harness.behavior.runCli(["reconcile"]);
  let board = (await harness.behavior.callRpc("board", { workstream: "auth-bug" })) as {
    tasks: { id: string; workerThreadId: string | null; status: string; title: string }[];
  };
  const adoptedSide = board.tasks.find((t) => t.workerThreadId === sideThread.id);
  assert.ok(adoptedSide !== undefined, "reparented standalone thread auto-adopted as Ariadne subthread");
  assert.equal(threads.get(sideThread.id)?.title, "🧵 Standalone investigation");

  const sideWorkerCfg = await harness.behavior.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({ thread: { id: sideThread.id } }),
  );
  assert.ok(sideWorkerCfg.tools.some((t) => t.name === "ariadne_report"));

  // Dragging that worker OUT of Ariadne (parentThreadId = null) auto-detaches it back to a normal standalone thread!
  threads.set(sideThread.id, { ...threads.get(sideThread.id)!, parentThreadId: null });
  await harness.behavior.runCli(["reconcile"]);
  board = (await harness.behavior.callRpc("board", { workstream: "auth-bug" })) as {
    tasks: { id: string; workerThreadId: string | null; status: string; title: string }[];
  };
  assert.equal(board.tasks.find((t) => t.id === adoptedSide.id)?.workerThreadId, null);
  assert.equal(threads.get(sideThread.id)?.title, "Standalone investigation");
  assert.equal(threads.get(sideThread.id)?.archivedAt, null, "detaching must NOT archive the standalone thread");

  const detachedCfg = await harness.behavior.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({ thread: { id: sideThread.id } }),
  );
  assert.deepEqual(detachedCfg.tools, []);
  assert.deepEqual(detachedCfg.skills, ["ariadne-orchestrate"]);

  // Ariadne can also switch a worker's model live and detach itself back to a normal thread!
  const childTask = board.tasks.find((t) => t.workerThreadId === existingChild.id)!;
  await harness.behavior.callAgentTool(
    "ariadne_steer",
    { taskId: childTask.id, model: "claude-opus-5-5", reasoningLevel: "high" },
    { threadId: normalThread.id },
  );
  assert.ok(
    harness.inspection.sdk
      .callsTo("threads.update")
      .some((c) => {
        const arg = c[0] as { threadId: string; model?: string };
        return arg.threadId === existingChild.id && arg.model === "claude-opus-5-5";
      }),
    "ariadne_steer updates worker model live",
  );

  await harness.behavior.callAgentTool("ariadne_session", { action: "detach" }, { threadId: normalThread.id });
  const afterDetachCfg = await harness.behavior.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({ thread: { id: normalThread.id } }),
  );
  assert.deepEqual(afterDetachCfg.tools, []);
  assert.deepEqual(afterDetachCfg.skills, ["ariadne-orchestrate"]);

  await harness.lifecycle.dispose();
});

test("plugin imports only public SDK surfaces", async () => {
  const scan = await experimental_scanPublicSdkOnly(PACKAGE_ROOT, {
    allow: [
      /^@\//,
      /^@radix-ui\//,
      /^class-variance-authority$/,
      /^clsx$/,
      /^sonner$/,
      /^tailwind-merge$/,
      /^vaul$/,
      /^react/,
      /^better-sqlite3$/,
    ],
  });
  assert.deepEqual(scan.violations, []);
  assert.deepEqual(scan.privateDependencies, []);
});
