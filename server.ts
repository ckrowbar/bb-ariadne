// bb-plugin-ariadne — backend entry.
//
// Ariadne pairs a pinned manager thread per workstream with a deterministic
// control-plane reconciler: durable zero-token watches, queued task
// dependencies with concurrency caps, fresh-context worker rotation reusing the
// task's worktree, hidden clean-context verification, and bounded CI/conflict
// reactions. Active workers stay nested under Ariadne via parentThreadId.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { PluginCliError, cliCommand, defineCli } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { boardRow } from "./src/board.ts";
import {
  CHANGED_CHANNEL,
  DEPENDS_MODES,
  REASONING_LEVELS,
  TASK_STATUSES,
  VERIFY_MODES,
  WATCH_KINDS,
  rpcContract,
  type AgentDefaults,
  type BoardTask,
  type DependsMode,
  type ExecutionConfig,
  type PrSummary,
  type ReasoningLevel,
  type RunPhase,
  type Task,
  type VerifyMode,
  type Watch,
  type WatchKind,
  type Workstream,
} from "./src/contract.ts";
import { openStore, type WorkstreamRow } from "./src/db.ts";
import {
  isReasoningLevel,
  mergeExecution,
  normalizeAgentDefaults,
  normalizeExecution,
  toSpawnExecutionArgs,
} from "./src/execution.ts";
import {
  branchExists,
  branchIsSafeToDelete,
  currentBranch,
  defaultBranch,
  deleteBranch,
  fetchGitHubPr,
  originUrl,
  parseGitHubRemote,
  refreshBase,
  runCheckCommand,
  worktreeDirt,
} from "./src/git.ts";
import { ariadneInstructions, MEMORY_INSTRUCTIONS, verifierInstructions, workerInstructions } from "./src/instructions.ts";
import { WorkerTurns } from "./src/notifications.ts";
import { decidePrReaction, shouldCompactManager, shouldRotateWorker, shouldRunVerifier } from "./src/reactions.ts";
import { computeTaskAttention, findDependencyCycle, isDependencySatisfied, planQueuedDispatch } from "./src/scheduler.ts";
import { evaluateWatch, parsePrTarget, parseTimerTarget } from "./src/watches.ts";

interface AriadneMetadata {
  role?: "ariadne" | "worker" | "verifier";
  workstream?: string;
  ariadneThreadId?: string;
  taskId?: string;
}

const AGENT_DEFAULTS_KV_KEY = "agent-defaults";
// BB's sidebar has no per-thread custom icons, so titles carry the mark.
const ARIADNE_MARK = "🧶";
const WORKER_MARK = "🧵";
const VERIFIER_MARK = "🔍";
const PLUGIN_PREFIX = "[ariadne plugin]";
const ORCHESTRATOR_PREFIX = "[ariadne orchestrator]";

function stripMark(title: string | null | undefined, mark: string): string {
  let value = (title ?? "").trim();
  while (value.startsWith(mark)) {
    value = value.slice(mark.length).trim();
  }
  return value;
}

function slugifyWorkstreamName(raw: string, exists: (name: string) => boolean): string {
  const base = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const root = base || "workstream";
  if (!exists(root)) return root;
  for (let i = 2; i < 100; i++) {
    const candidate = `${root}-${i}`;
    if (!exists(candidate)) return candidate;
  }
  return `${root}-${Date.now().toString(36)}`;
}

function errorText(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/** A confirmed "thread is gone" error; other errors may be transient. */
function isNotFound(error: unknown): boolean {
  return /\b404\b|not found/i.test(String(error));
}

function describeInteraction(interaction: unknown): string {
  const payload = (interaction as { payload?: Record<string, unknown> }).payload ?? {};
  const kind = typeof payload.kind === "string" ? payload.kind : "interaction";
  const questions = Array.isArray(payload.questions) ? (payload.questions as { prompt?: string }[]) : [];
  const prompt =
    typeof payload.prompt === "string" ? payload.prompt : questions.map((q) => q.prompt).filter(Boolean).join("; ");
  return prompt === "" ? kind : `${kind}: ${prompt}`;
}

function improvementKickoff(input: {
  problem: string;
  evidence?: string;
  proposal?: string;
  requestedBy: string;
  repo: string;
}): string {
  return `You are improving Ariadne, the BB plugin that runs manager threads (this repo). Ariadne @thread:${input.requestedBy} asked for this change on the user's behalf.

## Problem
${input.problem}
${input.evidence ? `\n## Evidence\n${input.evidence}\n` : ""}${input.proposal ? `\n## Suggested change\n${input.proposal}\n` : ""}
## Repo
- server.ts (backend: tools, events, reconciler, RPC, CLI), src/ (db, git, scheduler, reactions, watches, instructions, contract), app.tsx (UI).
- docs/v0-spec.md is the design; update it when behaviour changes. The README records findings.
- Plugin authoring docs: the bb-plugin-authoring skill.

## Definition of done
A draft PR in ${input.repo} with the change, a "## Motivation" section, and open questions listed.

## Rules
- Run npm ci if node_modules is missing. Before committing: npm test, npx tsc -p . and bb plugin build must pass.
- Keep the change small and focused on the problem. Match the surrounding code style.
- Never reload, reinstall or edit the live plugin checkout; the user applies merged changes.
- Commit on your branch, then push with: env -u GH_TOKEN -u GITHUB_TOKEN git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push -u origin HEAD
- Open the PR with: env -u GH_TOKEN -u GITHUB_TOKEN gh pr create --draft -R ${input.repo}
- Report the PR with ariadne_report (status pr-opened, prUrl), then finish with ariadne_report done.`;
}

function buildRotationPrompt(task: Task, instruction: string, phase: RunPhase): string {
  const sections: string[] = [
    `${ORCHESTRATOR_PREFIX} Fresh worker run (${phase}) for task ${task.id}: ${task.title}.`,
    `You are continuing in the task's existing git worktree${task.branch ? ` on branch ${task.branch}` : ""}${task.prUrl ? ` (${task.prUrl})` : ""}.`,
  ];
  if (task.prompt) sections.push(`## Original task contract\n${task.prompt.slice(0, 4000)}`);
  if (task.handoff) sections.push(`## Latest handoff\n${task.handoff.slice(0, 3000)}`);
  else if (task.summary) sections.push(`## Latest summary\n${task.summary.slice(0, 2000)}`);
  sections.push(`## Next action\n${instruction}`);
  return sections.join("\n\n");
}

function buildVerifierPrompt(task: Task, workerSummary: string, diffStat: string | null, focus?: string): string {
  const sections: string[] = [
    `Verify task ${task.id}: ${task.title}`,
    `Branch: ${task.branch ?? "(current worktree)"}${task.prUrl ? `\nPR: ${task.prUrl}` : ""}`,
  ];
  if (task.prompt) sections.push(`## Task contract\n${task.prompt.slice(0, 4000)}`);
  if (workerSummary) sections.push(`## Worker summary\n${workerSummary.slice(0, 3000)}`);
  if (task.handoff) sections.push(`## Worker handoff\n${task.handoff.slice(0, 2000)}`);
  if (diffStat) sections.push(`## Diff summary\n${diffStat.slice(0, 2000)}`);
  if (focus) sections.push(`## Requested focus\n${focus}`);
  sections.push(
    `Inspect the diff and touched code in this worktree, run the relevant tests/checks, and finish by calling ariadne_verify_verdict.`,
  );
  return sections.join("\n\n");
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    branchConvention: {
      type: "string",
      label: "Branch naming convention",
      description: "Workers rename their branch to this before pushing, e.g. <user>/<TICKET>/<slug>. Empty keeps BB's name.",
      default: "",
    },
    pluginProjectId: {
      type: "string",
      label: "Plugin repo project",
      description: "BB project id for this plugin's own repo. ariadne_improve spawns workers there. Empty disables ariadne_improve.",
      default: "",
    },
    maxConcurrentWorkers: {
      type: "number",
      label: "Max concurrent workers",
      description: "Maximum running + verifying tasks across workstreams before new tasks queue.",
      default: 3,
    },
    reconcileSeconds: {
      type: "number",
      label: "Reconciler interval (seconds)",
      description: "How often the control-plane loop checks watches, PRs, queued tasks and context usage.",
      default: 60,
    },
    autoReactCi: {
      type: "boolean",
      label: "Auto-fix failing PR checks",
      description: "Automatically steer the task worker when PR checks fail, up to maxReactionRetries.",
      default: true,
    },
    autoReactConflicts: {
      type: "boolean",
      label: "Auto-rebase merge conflicts",
      description: "Automatically steer the task worker to rebase when its PR has conflicts, up to maxReactionRetries.",
      default: true,
    },
    autoReactReviews: {
      type: "boolean",
      label: "Auto-address requested PR changes",
      description: "When enabled, automatically steer the worker on changes_requested instead of only notifying Ariadne.",
      default: false,
    },
    maxReactionRetries: {
      type: "number",
      label: "Max automatic reaction retries per issue",
      description: "Maximum automatic CI/conflict/review reaction attempts per task before escalating to Ariadne.",
      default: 2,
    },
    verifyByDefault: {
      type: "boolean",
      label: "Clean-context verifier gate",
      description: "Run a hidden read-only verifier on the worktree when a code task reports done.",
      default: true,
    },
    maxVerifyRetries: {
      type: "number",
      label: "Max verifier fix cycles",
      description: "How many times failed verification findings auto-route back to the coding worker before escalating.",
      default: 2,
    },
    workerRotateTokens: {
      type: "number",
      label: "Worker rotation context threshold (tokens)",
      description: "Rotate to a fresh nested worker thread on the same worktree on phase changes once context exceeds this. 0 disables.",
      default: 160_000,
    },
    managerCompactTokens: {
      type: "number",
      label: "Manager auto-compact threshold (tokens)",
      description: "Auto-compact an idle Ariadne manager thread once context exceeds this. 0 disables.",
      default: 140_000,
    },
    stuckMinutes: {
      type: "number",
      label: "Minutes before an idle running worker counts as stuck",
      default: 30,
    },
    dormantMinutes: {
      type: "number",
      label: "Minutes without activity before pausing non-watch PR polling",
      default: 60,
    },
  });
  let config = await settings.get();
  const store = openStore(bb);

  let pluginCheckout: string | null = null;
  function refreshPluginCheckout() {
    if (config.pluginProjectId === "") {
      pluginCheckout = null;
      return;
    }
    void bb.sdk.projects
      .get({ projectId: config.pluginProjectId })
      .then((project) => {
        pluginCheckout = (project.sources.find((s) => s.isDefault) ?? project.sources[0])?.path ?? null;
      })
      .catch((error: unknown) => bb.log.warn(`plugin project ${config.pluginProjectId}: ${String(error)}`));
  }
  refreshPluginCheckout();
  settings.onChange((next, prev) => {
    config = next;
    if (next.pluginProjectId !== prev.pluginProjectId) refreshPluginCheckout();
    kickReconciler();
  });

  let lastActivityAt = Date.now();
  const markActivity = () => {
    lastActivityAt = Date.now();
  };
  const publish = () => bb.realtime.publish(CHANGED_CHANNEL, { at: Date.now() });
  const workerTurns = new WorkerTurns(store.turnState);

  type PendingSessionAction = {
    kind: "reload" | "compact" | "clear-context";
    continuePrompt?: string;
  };
  const pendingSessionActions = new Map<string, PendingSessionAction>();
  const syncingThreads = new Set<string>();

  function isManagedThread(threadId: string): boolean {
    return (
      store.workstreamByAriadne(threadId) !== undefined ||
      store.activeTaskByWorker(threadId) !== undefined ||
      store.runByThread(threadId) !== undefined ||
      pendingSessionActions.has(threadId)
    );
  }

  async function executePendingSessionAction(threadId: string, action: PendingSessionAction) {
    try {
      if (action.kind === "compact") {
        await bb.sdk.threads.compact({ threadId });
        return;
      }
      if (action.kind === "clear-context") {
        await bb.sdk.threads.clearContext({ threadId });
        return;
      }
      // "reload": release loaded runtime cleanly while preserving conversation history
      // so the next turn constructs a fresh session with updated configure() tools & instructions.
      await bb.sdk.threads.stop({ threadId });
      if (action.continuePrompt && action.continuePrompt.trim() !== "") {
        await tellAriadne(
          threadId,
          `${PLUGIN_PREFIX} Session reloaded with Ariadne orchestrator tools active. Continue with:\n${action.continuePrompt.trim()}`,
        );
      }
    } catch (error) {
      bb.log.warn(`pending session action ${action.kind} on ${threadId} failed: ${String(error)}`);
    }
  }

  async function scheduleOrRunSessionAction(threadId: string, action: PendingSessionAction, deferIfActive = true) {
    const thread = await bb.sdk.threads.get({ threadId }).catch(() => null);
    if (deferIfActive && thread !== null && (thread.status === "active" || thread.status === "starting" || thread.status === "pending")) {
      pendingSessionActions.set(threadId, action);
      return "deferred" as const;
    }
    await executePendingSessionAction(threadId, action);
    return "immediate" as const;
  }

  // Wakeup channel for the background reconciler service.
  let wakeWaiter: (() => void) | null = null;
  function kickReconciler() {
    if (wakeWaiter !== null) {
      const fn = wakeWaiter;
      wakeWaiter = null;
      fn();
    }
  }

  function sleepOrWake(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        if (wakeWaiter === done) wakeWaiter = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      wakeWaiter = done;
      signal.addEventListener("abort", done, { once: true });
    });
  }

  async function getAgentDefaults(): Promise<AgentDefaults> {
    const stored = await bb.storage.kv.get<Partial<AgentDefaults>>(AGENT_DEFAULTS_KV_KEY);
    return normalizeAgentDefaults(stored);
  }

  async function setAgentDefaults(next: AgentDefaults): Promise<AgentDefaults> {
    const normalized = normalizeAgentDefaults(next);
    await bb.storage.kv.set(AGENT_DEFAULTS_KV_KEY, normalized);
    publish();
    return normalized;
  }

  async function tellAriadne(ariadneThreadId: string, message: string, senderThreadId?: string) {
    try {
      const input = [{ type: "text" as const, text: message, mentions: [], visibility: "agent-only" as const }];
      await bb.sdk.threads.send({ threadId: ariadneThreadId, mode: "auto", input, senderThreadId });
    } catch (error) {
      bb.log.warn(`tell ariadne ${ariadneThreadId} failed: ${String(error)}`);
    }
  }

  async function projectSource(projectId: string) {
    const project = await bb.sdk.projects.get({ projectId });
    const source = project.sources.find((s) => s.isDefault) ?? project.sources[0];
    return {
      name: project.name,
      kind: project.kind,
      remoteUrl: (source?.path ? await originUrl(source.path) : null) ?? project.gitRemoteUrl,
      path: source?.path ?? null,
      hostId: source?.hostId ?? null,
    };
  }

  const projectNames = new Map<string, string>();
  async function projectName(projectId: string): Promise<string | null> {
    if (!projectNames.has(projectId)) {
      try {
        projectNames.set(projectId, (await bb.sdk.projects.get({ projectId })).name);
      } catch {
        return null;
      }
    }
    return projectNames.get(projectId) ?? null;
  }

  async function readContextTokens(threadId: string): Promise<number | null> {
    try {
      const res = await bb.sdk.threads.context({ threadId });
      return res.usage?.usedTokens ?? null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- actions

  async function createWorkstream(
    name: string,
    projectId: string,
    links: string[],
    execution?: { ariadne?: Partial<ExecutionConfig>; worker?: Partial<ExecutionConfig> },
  ): Promise<string> {
    if (store.workstream(name) !== undefined) throw new Error(`Workstream "${name}" already exists.`);
    const [source, defaults] = await Promise.all([projectSource(projectId), getAgentDefaults()]);
    const ariadneOverride = normalizeExecution(execution?.ariadne);
    const workerOverride = normalizeExecution(execution?.worker);
    const resolvedAriadne = mergeExecution(defaults.ariadne, ariadneOverride);
    const environment =
      source.kind === "standard" && source.path !== null
        ? ({
            type: "host",
            hostId: source.hostId ?? undefined,
            workspace: { type: "unmanaged", path: source.path },
          } as const)
        : ({ type: "host", workspace: { type: "personal" } } as const);
    const thread = await bb.sdk.threads.spawn({
      projectId,
      environment,
      title: `${ARIADNE_MARK} ${name}`,
      prompt: `${PLUGIN_PREFIX} You are Ariadne for the workstream ${JSON.stringify(name)}. Introduce yourself in two sentences: what you can do, and that the user can hand you tickets here.`,
      pinned: true,
      permissionMode: "full",
      ...toSpawnExecutionArgs(resolvedAriadne),
      pluginMetadata: { role: "ariadne", workstream: name },
    });
    store.insertWorkstream(name, thread.id, projectId, links, {
      ariadne: ariadneOverride,
      worker: workerOverride,
    });
    store.event("workstream-created", thread.id, name);
    publish();
    return thread.id;
  }

  async function adoptWorkerThread(
    workstreamName: string,
    threadId: string,
    opts?: { title?: string; links?: string[]; reparent?: boolean; notifyAriadne?: boolean },
  ): Promise<{ task: Task; alreadyTracked: boolean }> {
    const ws = store.workstream(workstreamName);
    if (ws === undefined || ws.archived_at !== null) throw new Error(`No active workstream "${workstreamName}".`);
    if (threadId === ws.ariadne_thread_id) throw new Error("Cannot adopt the Ariadne manager thread as its own worker.");
    if (store.workstreamByAriadne(threadId) !== undefined) {
      throw new Error(`Thread ${threadId} is already an Ariadne manager thread.`);
    }
    if (store.runByThread(threadId)?.role === "verifier") {
      throw new Error(`Thread ${threadId} is a hidden verifier run.`);
    }

    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.archivedAt !== null || thread.deletedAt !== null) {
      throw new Error(`Thread ${threadId} is archived or deleted.`);
    }
    if (thread.visibility === "hidden" || thread.originKind !== null) {
      throw new Error(`Thread ${threadId} is hidden or a fork and cannot be adopted as a worker.`);
    }

    const existing = store.activeTaskByWorker(threadId);
    if (existing !== undefined) {
      if (existing.workstream === ws.name) return { task: existing, alreadyTracked: true };
      await detachWorkerTask(existing.id, { reparentToNull: false, notifyAriadne: true });
    }

    const cleanTitle =
      opts?.title?.trim() ||
      stripMark(thread.title ?? thread.titleFallback ?? threadId, WORKER_MARK) ||
      threadId;
    const task = store.insertTask({
      workstream: ws.name,
      title: cleanTitle.slice(0, 120),
      links: opts?.links ?? [],
      workerThreadId: threadId,
      environmentId: thread.environmentId,
      status: "running",
      projectId: thread.projectId,
    });
    store.insertRun({
      taskId: task.id,
      workstream: ws.name,
      role: "worker",
      phase: "adopt",
      threadId,
      status: "running",
    });

    syncingThreads.add(threadId);
    try {
      const updatePatch: { parentThreadId?: string; title?: string } = {};
      if (opts?.reparent !== false && thread.parentThreadId !== ws.ariadne_thread_id) {
        updatePatch.parentThreadId = ws.ariadne_thread_id;
      }
      const nextTitle = `${WORKER_MARK} ${cleanTitle}`;
      if ((thread.title ?? "").trim() !== nextTitle) {
        updatePatch.title = nextTitle;
      }
      if (Object.keys(updatePatch).length > 0) {
        await bb.sdk.threads.update({ threadId, ...updatePatch }).catch((err: unknown) => {
          bb.log.warn(`adopt worker update ${threadId}: ${String(err)}`);
        });
      }
      await bb.sdk.threads
        .updatePluginMetadata({
          threadId,
          set: { role: "worker", workstream: ws.name, ariadneThreadId: ws.ariadne_thread_id, taskId: task.id },
        })
        .catch((err: unknown) => bb.log.warn(`adopt worker metadata ${threadId}: ${String(err)}`));
    } finally {
      syncingThreads.delete(threadId);
    }

    await refreshBranch(task);
    await scheduleOrRunSessionAction(threadId, { kind: "reload" });
    store.event("worker-adopted", threadId, ws.name, task.id);
    markActivity();
    publish();
    kickReconciler();

    if (opts?.notifyAriadne) {
      await tellAriadne(
        ws.ariadne_thread_id,
        `${PLUGIN_PREFIX} Adopted @thread:${threadId} into this workstream as task ${task.id} (${task.title}).`,
        threadId,
      );
    }
    return { task: store.task(task.id) ?? task, alreadyTracked: false };
  }

  async function detachWorkerTask(
    taskId: string,
    opts?: { reparentToNull?: boolean; notifyAriadne?: boolean },
  ): Promise<string> {
    const task = store.task(taskId);
    if (task === undefined) throw new Error(`No task ${taskId}.`);
    const threadId = task.workerThreadId;
    store.cancelWatchesForTask(taskId);
    if (threadId !== null) {
      store.updateRunByThread(threadId, {
        status: "completed",
        summary: "Detached to normal standalone thread",
        endedAt: Date.now(),
      });
      workerTurns.clear(threadId);
    }
    const detachedNote = threadId ? `Detached to standalone thread @thread:${threadId}` : "Detached";
    store.updateTask(taskId, {
      workerThreadId: null,
      status: "dropped",
      summary: task.summary ? `${task.summary} (${detachedNote})` : detachedNote,
    });

    if (threadId !== null) {
      syncingThreads.add(threadId);
      try {
        const thread = await bb.sdk.threads.get({ threadId }).catch(() => null);
        if (thread !== null && thread.archivedAt === null && thread.deletedAt === null) {
          const stripped = stripMark(thread.title, WORKER_MARK);
          const patch: { parentThreadId?: null; title?: string } = {};
          if (opts?.reparentToNull !== false && thread.parentThreadId !== null) patch.parentThreadId = null;
          if (stripped && stripped !== thread.title) patch.title = stripped;
          if (Object.keys(patch).length > 0) {
            await bb.sdk.threads.update({ threadId, ...patch }).catch((err: unknown) => {
              bb.log.warn(`detach worker update ${threadId}: ${String(err)}`);
            });
          }
          await bb.sdk.threads
            .updatePluginMetadata({ threadId, remove: ["role", "workstream", "ariadneThreadId", "taskId"] })
            .catch((err: unknown) => bb.log.warn(`detach worker metadata ${threadId}: ${String(err)}`));
          await scheduleOrRunSessionAction(threadId, { kind: "reload" });
        }
      } finally {
        syncingThreads.delete(threadId);
      }
    }

    store.event("worker-detached", threadId ?? "-", task.workstream, task.id);
    publish();
    kickReconciler();

    if (opts?.notifyAriadne) {
      const ws = store.workstream(task.workstream);
      if (ws !== undefined && ws.archived_at === null) {
        await tellAriadne(
          ws.ariadne_thread_id,
          `${PLUGIN_PREFIX} Task ${task.id} (${task.title}) was detached from this workstream; ${threadId ? `@thread:${threadId}` : "its thread"} is now a normal standalone thread.`,
        );
      }
    }
    return `Detached ${task.id} (${task.title}); ${threadId ? `@thread:${threadId}` : "thread"} is now a normal standalone thread.`;
  }

  async function adoptThreadAsWorkstream(
    threadId: string,
    opts?: { name?: string; links?: string[]; pin?: boolean; continuePrompt?: string },
  ): Promise<{ name: string; adoptedChildren: number; reloadMode: "deferred" | "immediate" }> {
    const existingWs = store.workstreamByAriadne(threadId);
    if (existingWs !== undefined) {
      if (existingWs.archived_at !== null) {
        const thread = await bb.sdk.threads.get({ threadId }).catch(() => null);
        const cleanTitle = (
          stripMark(thread?.title, ARIADNE_MARK) ||
          opts?.name?.trim() ||
          store.workstreamTitle(existingWs)
        ).slice(0, 120);
        store.unarchiveWorkstream(existingWs.name);
        store.updateWorkstream(existingWs.name, { title: cleanTitle });
        syncingThreads.add(threadId);
        try {
          if (thread !== null && thread.archivedAt === null && thread.deletedAt === null) {
            await bb.sdk.threads
              .update({ threadId, title: `${ARIADNE_MARK} ${cleanTitle}` })
              .catch((err: unknown) => bb.log.warn(`re-adopt ariadne title ${threadId}: ${String(err)}`));
            if (opts?.pin !== false) {
              await bb.sdk.threads.pin({ threadId }).catch((err: unknown) => bb.log.warn(`re-adopt ariadne pin ${threadId}: ${String(err)}`));
            }
            await bb.sdk.threads
              .updatePluginMetadata({ threadId, set: { role: "ariadne", workstream: existingWs.name } })
              .catch((err: unknown) => bb.log.warn(`re-adopt ariadne metadata ${threadId}: ${String(err)}`));
          }
        } finally {
          syncingThreads.delete(threadId);
        }
        publish();
        const reloadMode = await scheduleOrRunSessionAction(threadId, {
          kind: "reload",
          continuePrompt: opts?.continuePrompt,
        });
        return { name: existingWs.name, adoptedChildren: 0, reloadMode };
      }
      throw new Error(`Thread ${threadId} is already Ariadne workstream "${existingWs.name}".`);
    }
    if (store.activeTaskByWorker(threadId) !== undefined) {
      throw new Error(`Thread ${threadId} is an active Ariadne worker; detach it before promoting it to its own Ariadne workstream.`);
    }
    if (store.runByThread(threadId)?.role === "verifier") {
      throw new Error(`Thread ${threadId} is a hidden verifier run.`);
    }

    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.archivedAt !== null || thread.deletedAt !== null) {
      throw new Error(`Thread ${threadId} is archived or deleted.`);
    }

    const explicitName = opts?.name?.trim() ?? "";
    const name =
      explicitName !== ""
        ? explicitName
        : slugifyWorkstreamName(stripMark(thread.title ?? thread.titleFallback ?? threadId, ARIADNE_MARK), (n) => store.workstream(n) !== undefined);
    if (store.workstream(name) !== undefined) throw new Error(`Workstream "${name}" already exists.`);

    const cleanTitle = (
      stripMark(thread.title, ARIADNE_MARK) ||
      explicitName ||
      stripMark(thread.titleFallback, ARIADNE_MARK) ||
      name
    ).slice(0, 120);

    const execOpts = await bb.sdk.threads.defaultExecutionOptions({ threadId }).catch(() => null);
    const ariadneExec: Partial<ExecutionConfig> = {
      providerId: thread.providerId ?? null,
      model: execOpts?.model ?? null,
      reasoningLevel: execOpts?.reasoningLevel ?? null,
      serviceTier: execOpts?.serviceTier ?? null,
    };

    store.insertWorkstream(name, threadId, thread.projectId, opts?.links ?? [], { ariadne: ariadneExec, title: cleanTitle });

    syncingThreads.add(threadId);
    try {
      await bb.sdk.threads
        .update({ threadId, title: `${ARIADNE_MARK} ${cleanTitle}` })
        .catch((err: unknown) => bb.log.warn(`adopt ariadne title ${threadId}: ${String(err)}`));
      if (opts?.pin !== false) {
        await bb.sdk.threads.pin({ threadId }).catch((err: unknown) => bb.log.warn(`adopt ariadne pin ${threadId}: ${String(err)}`));
      }
      await bb.sdk.threads
        .updatePluginMetadata({ threadId, set: { role: "ariadne", workstream: name } })
        .catch((err: unknown) => bb.log.warn(`adopt ariadne metadata ${threadId}: ${String(err)}`));
    } finally {
      syncingThreads.delete(threadId);
    }

    // Automatically adopt any existing normal child threads nested under this thread.
    let adoptedChildren = 0;
    const children = await bb.sdk.threads
      .list({ parentThreadId: threadId, archived: false })
      .catch(() => [] as Awaited<ReturnType<typeof bb.sdk.threads.list>>);
    for (const child of children) {
      if (child.visibility === "hidden" || child.originKind !== null || child.archivedAt !== null || child.deletedAt !== null) {
        continue;
      }
      try {
        await adoptWorkerThread(name, child.id, { reparent: false, notifyAriadne: false });
        adoptedChildren += 1;
      } catch (err) {
        bb.log.warn(`adopt existing child ${child.id} under ${name}: ${String(err)}`);
      }
    }

    store.event("workstream-adopted", `${threadId} (${adoptedChildren} children)`, name);
    markActivity();
    publish();
    const reloadMode = await scheduleOrRunSessionAction(threadId, {
      kind: "reload",
      continuePrompt: opts?.continuePrompt,
    });
    return { name, adoptedChildren, reloadMode };
  }

  async function detachWorkstream(name: string, opts?: { unpin?: boolean }): Promise<string> {
    const ws = store.workstream(name);
    if (ws === undefined) throw new Error(`No workstream "${name}".`);
    store.cancelWatchesForWorkstream(name);
    for (const task of store.tasks(name)) {
      if (task.workerThreadId !== null && task.status !== "done" && task.status !== "dropped") {
        await detachWorkerTask(task.id, { reparentToNull: false, notifyAriadne: false });
      }
    }
    store.archiveWorkstream(name);
    syncingThreads.add(ws.ariadne_thread_id);
    try {
      const thread = await bb.sdk.threads.get({ threadId: ws.ariadne_thread_id }).catch(() => null);
      if (thread !== null && thread.archivedAt === null && thread.deletedAt === null) {
        const stripped = stripMark(thread.title, ARIADNE_MARK);
        if (stripped && stripped !== thread.title) {
          await bb.sdk.threads
            .update({ threadId: ws.ariadne_thread_id, title: stripped })
            .catch((err: unknown) => bb.log.warn(`detach ariadne title ${ws.ariadne_thread_id}: ${String(err)}`));
        }
        if (opts?.unpin !== false) {
          await bb.sdk.threads
            .unpin({ threadId: ws.ariadne_thread_id })
            .catch((err: unknown) => bb.log.warn(`detach ariadne unpin ${ws.ariadne_thread_id}: ${String(err)}`));
        }
        await bb.sdk.threads
          .updatePluginMetadata({ threadId: ws.ariadne_thread_id, remove: ["role", "workstream"] })
          .catch((err: unknown) => bb.log.warn(`detach ariadne metadata ${ws.ariadne_thread_id}: ${String(err)}`));
        await scheduleOrRunSessionAction(ws.ariadne_thread_id, { kind: "reload" });
      }
    } finally {
      syncingThreads.delete(ws.ariadne_thread_id);
    }
    store.event("workstream-detached", ws.ariadne_thread_id, name);
    publish();
    return `Detached workstream "${name}"; @thread:${ws.ariadne_thread_id} is now a normal thread (session reloads when idle).`;
  }

  async function reconcileThreadParentChange(threadId: string) {
    if (syncingThreads.has(threadId)) return;
    if (store.workstreamByAriadne(threadId) !== undefined) return;
    if (store.runByThread(threadId)?.role === "verifier") return;
    const thread = await bb.sdk.threads.get({ threadId }).catch(() => null);
    if (thread === null || thread.archivedAt !== null || thread.deletedAt !== null) return;
    if (thread.visibility === "hidden" || thread.originKind !== null) return;

    const parentWs =
      thread.parentThreadId !== null ? store.workstreamByAriadne(thread.parentThreadId) : undefined;
    const activeParentWs = parentWs !== undefined && parentWs.archived_at === null ? parentWs : undefined;
    const currentTask = store.activeTaskByWorker(threadId);

    if (activeParentWs !== undefined) {
      if (currentTask === undefined || currentTask.workstream !== activeParentWs.name) {
        await adoptWorkerThread(activeParentWs.name, threadId, { reparent: false, notifyAriadne: true }).catch((err: unknown) => {
          bb.log.warn(`auto-adopt child ${threadId} under ${activeParentWs.name}: ${String(err)}`);
        });
      }
      return;
    }

    if (currentTask !== undefined) {
      const taskWs = store.workstream(currentTask.workstream);
      if (taskWs !== undefined && taskWs.archived_at === null && thread.parentThreadId !== taskWs.ariadne_thread_id) {
        await detachWorkerTask(currentTask.id, { reparentToNull: false, notifyAriadne: true }).catch((err: unknown) => {
          bb.log.warn(`auto-detach worker ${threadId} from ${currentTask.workstream}: ${String(err)}`);
        });
      }
    }
  }

  async function syncThreadTitle(thread: {
    id: string;
    title: string | null;
    archivedAt: number | null;
    deletedAt: number | null;
    visibility?: string;
  }) {
    if (syncingThreads.has(thread.id)) return;
    if (thread.archivedAt !== null || thread.deletedAt !== null || thread.visibility === "hidden") return;
    const rawTitle = (thread.title ?? "").trim();
    if (rawTitle === "") return;

    const ws = store.workstreamByAriadne(thread.id);
    if (ws !== undefined && ws.archived_at === null) {
      const cleanTitle = (stripMark(rawTitle, ARIADNE_MARK) || store.workstreamTitle(ws)).slice(0, 120);
      const expectedTitle = `${ARIADNE_MARK} ${cleanTitle}`;
      if (rawTitle !== expectedTitle) {
        syncingThreads.add(thread.id);
        try {
          await bb.sdk.threads.update({ threadId: thread.id, title: expectedTitle }).catch((err: unknown) => {
            bb.log.warn(`preserve ariadne mark ${thread.id}: ${String(err)}`);
          });
        } finally {
          syncingThreads.delete(thread.id);
        }
      }
      if (store.workstreamTitle(ws) !== cleanTitle) {
        store.updateWorkstream(ws.name, { title: cleanTitle });
        publish();
      }
      return;
    }

    const task = store.activeTaskByWorker(thread.id);
    if (task !== undefined && task.status !== "dropped") {
      const taskWs = store.workstream(task.workstream);
      if (taskWs === undefined || taskWs.archived_at !== null) return;
      const cleanTitle = (stripMark(rawTitle, WORKER_MARK) || task.title).slice(0, 120);
      const expectedTitle = `${WORKER_MARK} ${cleanTitle}`;
      if (rawTitle !== expectedTitle) {
        syncingThreads.add(thread.id);
        try {
          await bb.sdk.threads.update({ threadId: thread.id, title: expectedTitle }).catch((err: unknown) => {
            bb.log.warn(`preserve worker mark ${thread.id}: ${String(err)}`);
          });
        } finally {
          syncingThreads.delete(thread.id);
        }
      }
      if (task.title !== cleanTitle) {
        store.updateTask(task.id, { title: cleanTitle });
        publish();
      }
    }
  }

  async function reconcileThreadTitleChange(threadId: string) {
    if (syncingThreads.has(threadId)) return;
    const ws = store.workstreamByAriadne(threadId);
    const isActiveManager = ws !== undefined && ws.archived_at === null;
    const task = isActiveManager ? undefined : store.activeTaskByWorker(threadId);
    const isActiveWorker = task !== undefined && task.status !== "dropped";
    if (!isActiveManager && !isActiveWorker) return;
    const thread = await bb.sdk.threads.get({ threadId }).catch(() => null);
    if (thread === null) return;
    await syncThreadTitle(thread);
  }

  async function syncWorkstreamChildren() {
    const activeWorkstreams = store.workstreams().filter((w) => w.archived_at === null);
    for (const ws of activeWorkstreams) {
      await reconcileThreadTitleChange(ws.ariadne_thread_id);
      const children = await bb.sdk.threads
        .list({ parentThreadId: ws.ariadne_thread_id, archived: false })
        .catch(() => null);
      if (children !== null) {
        for (const child of children) {
          if (syncingThreads.has(child.id)) continue;
          if (child.visibility === "hidden" || child.originKind !== null || child.archivedAt !== null || child.deletedAt !== null) {
            continue;
          }
          if (store.workstreamByAriadne(child.id) !== undefined) continue;
          if (store.runByThread(child.id)?.role === "verifier") continue;
          const existing = store.activeTaskByWorker(child.id);
          if (existing !== undefined && existing.workstream === ws.name) {
            await syncThreadTitle(child);
            continue;
          }
          // Ignore superseded worker runs that haven't finished archiving yet.
          if (store.runByThread(child.id)?.status === "superseded") continue;
          await adoptWorkerThread(ws.name, child.id, { reparent: false, notifyAriadne: true }).catch((err: unknown) => {
            bb.log.warn(`sync adopt child ${child.id}: ${String(err)}`);
          });
        }
      }
      for (const task of store.tasks(ws.name)) {
        if (task.workerThreadId === null || task.status === "done" || task.status === "dropped") continue;
        if (syncingThreads.has(task.workerThreadId)) continue;
        const thread = await bb.sdk.threads.get({ threadId: task.workerThreadId }).catch(() => null);
        if (thread === null || thread.archivedAt !== null || thread.deletedAt !== null) continue;
        if (thread.parentThreadId !== ws.ariadne_thread_id) {
          await reconcileThreadParentChange(task.workerThreadId);
        }
      }
    }
  }

  async function resolveWorkerExecution(ws: WorkstreamRow, taskOverride?: Partial<ExecutionConfig> | null): Promise<ExecutionConfig> {
    const defaults = await getAgentDefaults();
    const workstreamWorker = store.workerExecution(ws);
    return mergeExecution(mergeExecution(defaults.worker, workstreamWorker), normalizeExecution(taskOverride));
  }

  function enrichPromptWithDependencies(task: Task): string {
    const base = task.prompt ?? task.title;
    if (task.dependsOn.length === 0) return base;
    const depLines: string[] = [];
    for (const depId of task.dependsOn) {
      const dep = store.task(depId);
      if (dep === undefined) continue;
      const bits = [`- ${dep.id} (${dep.title}): status=${dep.status}`];
      if (dep.branch) bits.push(`branch=${dep.branch}`);
      if (dep.prUrl) bits.push(`pr=${dep.prUrl}`);
      if (dep.summary) bits.push(`summary=${dep.summary.slice(0, 400)}`);
      depLines.push(bits.join(" | "));
    }
    if (depLines.length === 0) return base;
    return `${base}\n\n## Completed upstream dependencies\n${depLines.join("\n")}`;
  }

  async function launchTaskWorker(task: Task): Promise<{ task: Task; note: string }> {
    const ws = store.workstream(task.workstream);
    if (ws === undefined) throw new Error(`No workstream ${task.workstream}.`);
    const projectId = task.projectId ?? ws.project_id;
    const [source, resolvedWorker] = await Promise.all([
      projectSource(projectId),
      resolveWorkerExecution(ws, task.execution),
    ]);
    let environment;
    let note = "";
    if (source.kind === "standard" && source.path !== null) {
      let branch = task.baseBranch ?? null;
      if (branch === null && task.dependsMode === "pr-opened" && task.dependsOn.length === 1) {
        const dep = store.task(task.dependsOn[0]!);
        if (dep?.branch) branch = dep.branch;
      }
      const resolvedBranch = branch ?? (await defaultBranch(source.path));
      const base = await refreshBase(source.path, source.remoteUrl, resolvedBranch);
      note = base.fresh ? `based on origin/${resolvedBranch} at ${base.sha.slice(0, 12)}` : `WARNING: ${base.warning}`;
      environment = {
        type: "host",
        hostId: source.hostId ?? undefined,
        workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: base.sha } },
      } as const;
    } else {
      environment = { type: "host", workspace: { type: "personal" } } as const;
    }

    const thread = await bb.sdk.threads.spawn({
      projectId,
      environment,
      title: `${WORKER_MARK} ${task.title}`,
      prompt: enrichPromptWithDependencies(task),
      permissionMode: "full",
      ...toSpawnExecutionArgs(resolvedWorker),
      parentThreadId: ws.ariadne_thread_id,
      pluginMetadata: { role: "worker", workstream: ws.name, ariadneThreadId: ws.ariadne_thread_id, taskId: task.id },
    });
    const updated = store.updateTask(task.id, {
      status: "running",
      workerThreadId: thread.id,
      environmentId: thread.environmentId,
    })!;
    store.insertRun({
      taskId: task.id,
      workstream: ws.name,
      role: "worker",
      phase: "implement",
      threadId: thread.id,
      status: "running",
    });
    workerTurns.started(thread.id, "ariadne");
    store.event("worker-spawned", `${thread.id} ${note}`, ws.name, task.id);
    markActivity();
    publish();
    return { task: updated, note };
  }

  async function spawnOrQueueWorker(
    ariadneThreadId: string,
    args: {
      title: string;
      prompt: string;
      links?: string[];
      providerId?: string;
      model?: string;
      reasoningLevel?: ReasoningLevel;
      serviceTier?: string;
      baseBranch?: string;
      projectId?: string;
      dependsOn?: string[];
      dependsMode?: DependsMode;
      verifyMode?: VerifyMode;
      queueOnly?: boolean;
    },
  ): Promise<{ task: Task; queued: boolean; note: string }> {
    const ws = store.workstreamByAriadne(ariadneThreadId);
    if (ws === undefined) throw new Error("This Ariadne thread has no workstream record.");

    const deps = [...new Set((args.dependsOn ?? []).map((d) => d.trim()).filter(Boolean))];
    const wsTasks = store.tasks(ws.name);
    for (const depId of deps) {
      const dep = wsTasks.find((t) => t.id === depId);
      if (dep === undefined) throw new Error(`Dependency ${depId} not found in workstream "${ws.name}".`);
      if (dep.status === "dropped") throw new Error(`Dependency ${depId} (${dep.title}) is dropped.`);
    }

    const dependsMode: DependsMode = args.dependsMode ?? "done";
    const verifyMode: VerifyMode = args.verifyMode ?? "auto";
    const argOverride = normalizeExecution({
      providerId: args.providerId ?? null,
      model: args.model ?? null,
      reasoningLevel: args.reasoningLevel ?? null,
      serviceTier: args.serviceTier ?? null,
    });

    const task = store.insertTask({
      workstream: ws.name,
      title: args.title,
      links: args.links ?? [],
      workerThreadId: null,
      environmentId: null,
      status: "queued",
      prompt: args.prompt,
      baseBranch: args.baseBranch ?? null,
      projectId: args.projectId ?? null,
      execution: argOverride,
      dependsOn: deps,
      dependsMode,
      verifyMode,
    });

    const byId = new Map(wsTasks.map((t) => [t.id, t]));
    const depsReady = deps.every((id) => isDependencySatisfied(byId.get(id), dependsMode));
    const activeCount = store.allTasks().filter((t) => t.status === "running" || t.status === "verifying").length;
    const cap = Math.max(1, Math.round(config.maxConcurrentWorkers));

    if (args.queueOnly || !depsReady || activeCount >= cap) {
      const reason = args.queueOnly
        ? "queued as requested"
        : !depsReady
          ? `waiting on ${deps.join(", ")}`
          : `at concurrency cap (${activeCount}/${cap})`;
      store.event("task-queued", reason, ws.name, task.id);
      markActivity();
      publish();
      return { task, queued: true, note: reason };
    }

    const launched = await launchTaskWorker(task);
    return { task: launched.task, queued: false, note: launched.note };
  }

  /** Task environments are only known once BB provisions them, after spawn returns. */
  async function environmentIdFor(task: Task): Promise<string | null> {
    if (task.environmentId !== null) return task.environmentId;
    if (task.workerThreadId === null) return null;
    const thread = await bb.sdk.threads.get({ threadId: task.workerThreadId }).catch(() => null);
    const environmentId = thread?.environmentId ?? null;
    if (environmentId !== null) store.updateTask(task.id, { environmentId });
    return environmentId;
  }

  /**
   * Rotates a task to a fresh nested worker thread reusing the same worktree.
   * Spawns the new run BEFORE archiving the old one so BB never retires the
   * worktree (retirement only starts after the last live thread archives).
   */
  async function rotateTaskWorker(
    task: Task,
    instruction: string,
    phase: RunPhase,
    starter: "ariadne" | "orchestrator",
  ): Promise<{ threadId: string; runNumber: number }> {
    const ws = store.workstream(task.workstream);
    if (ws === undefined) throw new Error(`No workstream ${task.workstream}.`);
    const environmentId = await environmentIdFor(task);
    if (environmentId === null) throw new Error(`Task ${task.id} has no provisioned environment to reuse.`);
    const env = await bb.sdk.environments.get({ environmentId });
    if (env.lifecycle.phase === "destroyed") {
      throw new Error(`Task ${task.id}'s environment is already destroyed.`);
    }

    const resolvedWorker = await resolveWorkerExecution(ws, task.execution);
    const prevThreadId = task.workerThreadId;
    const prevTokens = prevThreadId ? await readContextTokens(prevThreadId) : task.contextTokens;
    const prompt = buildRotationPrompt(task, instruction, phase);

    const newThread = await bb.sdk.threads.spawn({
      projectId: task.projectId ?? ws.project_id,
      environment: { type: "reuse", environmentId },
      title: `${WORKER_MARK} ${task.title}`,
      prompt,
      permissionMode: "full",
      ...toSpawnExecutionArgs(resolvedWorker),
      parentThreadId: ws.ariadne_thread_id,
      pluginMetadata: { role: "worker", workstream: ws.name, ariadneThreadId: ws.ariadne_thread_id, taskId: task.id },
    });

    if (prevThreadId !== null) {
      store.updateRunByThread(prevThreadId, {
        status: "superseded",
        contextTokens: prevTokens,
        endedAt: Date.now(),
      });
      workerTurns.clear(prevThreadId);
    }
    const run = store.insertRun({
      taskId: task.id,
      workstream: ws.name,
      role: "worker",
      phase,
      threadId: newThread.id,
      status: "running",
    });
    store.updateTask(task.id, {
      status: "running",
      workerThreadId: newThread.id,
      environmentId,
      contextTokens: null,
    });
    workerTurns.started(newThread.id, starter);
    store.event(
      "worker-rotated",
      `${prevThreadId ?? "-"} -> ${newThread.id} (run #${run.runNumber}, ${phase}${prevTokens ? `, prev ${Math.round(prevTokens / 1000)}k tok` : ""})`,
      ws.name,
      task.id,
    );

    // Archive superseded thread AFTER the new thread is attached to the environment.
    if (prevThreadId !== null) {
      await bb.sdk.threads.stop({ threadId: prevThreadId }).catch((err: unknown) => {
        bb.log.warn(`stop superseded worker ${prevThreadId}: ${String(err)}`);
      });
      await bb.sdk.threads.archive({ threadId: prevThreadId }).catch((err: unknown) => {
        bb.log.warn(`archive superseded worker ${prevThreadId}: ${String(err)}`);
      });
    }

    markActivity();
    publish();
    return { threadId: newThread.id, runNumber: run.runNumber };
  }

  /**
   * Steers a task's active worker, or rotates to a fresh nested run on the same
   * worktree when requested or when context usage exceeds workerRotateTokens.
   */
  async function steerOrRotateTask(
    task: Task,
    message: string,
    phase: RunPhase,
    starter: "ariadne" | "orchestrator",
    opts?: { forceRotate?: boolean; senderThreadId?: string },
  ): Promise<{ rotated: boolean; threadId: string }> {
    if (task.workerThreadId === null) {
      const launched = await launchTaskWorker(store.updateTask(task.id, { prompt: `${task.prompt ?? ""}\n\n${message}`.trim() })!);
      return { rotated: false, threadId: launched.task.workerThreadId! };
    }
    const tokens = await readContextTokens(task.workerThreadId);
    if (tokens !== null) store.updateTask(task.id, { contextTokens: tokens });
    const wantRotate = Boolean(opts?.forceRotate) || shouldRotateWorker(tokens ?? task.contextTokens, config.workerRotateTokens);
    if (wantRotate) {
      try {
        const rotated = await rotateTaskWorker(task, message, phase, starter);
        return { rotated: true, threadId: rotated.threadId };
      } catch (error) {
        bb.log.warn(`rotate ${task.id} failed, falling back to send: ${String(error)}`);
      }
    }
    store.updateTask(task.id, { status: "running" });
    workerTurns.started(task.workerThreadId, starter);
    await bb.sdk.threads.send({
      threadId: task.workerThreadId,
      mode: "auto",
      input: [{ type: "text", text: message, mentions: [] }],
      senderThreadId: opts?.senderThreadId,
    });
    store.event("worker-steered", `${phase} (${starter}) -> ${task.workerThreadId}`, task.workstream, task.id);
    markActivity();
    publish();
    return { rotated: false, threadId: task.workerThreadId };
  }

  // ------------------------------------------------ clean-context verifier

  async function readEnvironmentDiffFiles(environmentId: string) {
    const env = await bb.sdk.environments.get({ environmentId }).catch(() => null);
    const mergeBaseBranch = env?.defaultBranch ?? "main";
    const all = await bb.sdk.environments
      .diffFiles({ environmentId, target: "all", mergeBaseBranch })
      .catch(() => null);
    if (all?.outcome === "available") return all;
    return bb.sdk.environments.diffFiles({ environmentId, target: "uncommitted" }).catch(() => null);
  }

  async function taskHasDiffOrPr(task: Task, prUrl?: string): Promise<boolean> {
    if (prUrl || task.prUrl || task.pr !== null) return true;
    const environmentId = await environmentIdFor(task);
    if (environmentId === null) return false;
    const diff = await readEnvironmentDiffFiles(environmentId);
    if (diff?.outcome === "available" && diff.files.length > 0) return true;
    try {
      const status = await bb.sdk.environments.status({ environmentId });
      if (status.outcome === "available" && (status.workspace.mergeBase?.aheadCount ?? 0) > 0) return true;
    } catch {
      // Ignore.
    }
    return false;
  }

  async function startVerification(
    task: Task,
    workerSummary: string,
    focus?: string,
  ): Promise<{ started: boolean; threadId?: string; reason?: string }> {
    const ws = store.workstream(task.workstream);
    if (ws === undefined) return { started: false, reason: "missing workstream" };
    const alreadyRunning = store.runsForTask(task.id).find((r) => r.role === "verifier" && r.status === "running");
    if (alreadyRunning !== undefined) {
      return { started: false, threadId: alreadyRunning.threadId, reason: "verifier already running" };
    }
    const environmentId = await environmentIdFor(task);
    if (environmentId === null) return { started: false, reason: "no environment" };
    const env = await bb.sdk.environments.get({ environmentId }).catch(() => null);
    if (env === null || env.lifecycle.phase === "destroyed") {
      return { started: false, reason: "environment unavailable" };
    }

    let diffStat: string | null = null;
    const diff = await readEnvironmentDiffFiles(environmentId);
    if (diff?.outcome === "available") {
      const fileList = diff.files
        .slice(0, 25)
        .map((f) => `${f.changeKind} ${f.path} (+${f.additions}/-${f.deletions})`)
        .join("\n");
      diffStat = [diff.shortstat, fileList].filter(Boolean).join("\n");
    }

    const resolvedWorker = await resolveWorkerExecution(ws, task.execution);
    const verifierThread = await bb.sdk.threads.spawn({
      projectId: task.projectId ?? ws.project_id,
      environment: { type: "reuse", environmentId },
      title: `${VERIFIER_MARK} Verify: ${task.title}`,
      prompt: buildVerifierPrompt(task, workerSummary, diffStat, focus),
      visibility: "hidden",
      permissionMode: "full",
      ...toSpawnExecutionArgs(resolvedWorker),
      // Deliberately NO parentThreadId so hidden verifiers never clutter the sidebar or spam Ariadne.
      pluginMetadata: { role: "verifier", workstream: ws.name, ariadneThreadId: ws.ariadne_thread_id, taskId: task.id },
    });

    store.insertRun({
      taskId: task.id,
      workstream: ws.name,
      role: "verifier",
      phase: "verify",
      threadId: verifierThread.id,
      status: "running",
    });
    store.updateTask(task.id, { status: "verifying" });
    store.event("verifier-started", `${verifierThread.id}`, ws.name, task.id);
    markActivity();
    publish();
    return { started: true, threadId: verifierThread.id };
  }

  async function cleanupHiddenThread(threadId: string) {
    await bb.sdk.threads.archive({ threadId }).catch((err: unknown) => {
      if (!isNotFound(err)) bb.log.warn(`archive verifier ${threadId}: ${String(err)}`);
    });
    await bb.sdk.threads.stop({ threadId }).catch((err: unknown) => {
      if (!isNotFound(err)) bb.log.warn(`stop verifier ${threadId}: ${String(err)}`);
    });
  }

  async function settleVerification(
    verifierThreadId: string,
    result: { passed: boolean; summary: string; issues?: string[]; checksRun?: string },
    opts?: { cleanupNow?: boolean },
  ): Promise<string> {
    const run = store.runByThread(verifierThreadId);
    if (run === undefined || run.role !== "verifier") return "Not a verifier run.";
    if (run.status !== "running") return "Verification already settled.";

    const tokens = await readContextTokens(verifierThreadId);
    store.updateRunByThread(verifierThreadId, {
      status: result.passed ? "passed" : "rejected",
      summary: result.summary.slice(0, 2000),
      contextTokens: tokens,
      endedAt: Date.now(),
    });

    if (opts?.cleanupNow !== false) {
      await cleanupHiddenThread(verifierThreadId);
    }

    const task = store.task(run.taskId);
    const ws = task === undefined ? undefined : store.workstream(task.workstream);
    if (task === undefined || ws === undefined) return "Task no longer exists.";

    const issuesBlock =
      result.issues && result.issues.length > 0 ? `\nIssues:\n- ${result.issues.join("\n- ")}` : "";
    const checksBlock = result.checksRun ? `\nChecks run: ${result.checksRun}` : "";

    if (result.passed) {
      store.resetReaction(task.id, "verify_failed");
      const hasOpenPr = task.prUrl !== null && task.pr?.state !== "merged";
      const nextStatus = hasOpenPr ? "in-review" : "done";
      const handoff = [task.handoff, `Verified (${verifierThreadId}): ${result.summary}${checksBlock}`]
        .filter(Boolean)
        .join("\n\n")
        .slice(0, 6000);
      store.updateTask(task.id, { status: nextStatus, handoff });
      store.event("verifier-passed", `${verifierThreadId}: ${result.summary}`, ws.name, task.id);
      publish();
      await tellAriadne(
        ws.ariadne_thread_id,
        `${PLUGIN_PREFIX} Clean-context verification PASSED for ${task.id} (${task.title}) via @thread:${verifierThreadId} (now ${nextStatus}): ${result.summary}${checksBlock}`,
        verifierThreadId,
      );
      kickReconciler();
      return `Verification passed; task ${task.id} moved to ${nextStatus}.`;
    }

    const attempt = store.bumpReaction(task.id, "verify_failed");
    const maxAttempts = Math.max(0, Math.round(config.maxVerifyRetries));
    const handoff = [
      task.handoff,
      `Verification FAILED attempt ${attempt}/${maxAttempts} (${verifierThreadId}): ${result.summary}${issuesBlock}${checksBlock}`,
    ]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 6000);
    store.updateTask(task.id, { handoff });
    store.event("verifier-failed", `attempt ${attempt}/${maxAttempts} ${verifierThreadId}: ${result.summary}`, ws.name, task.id);

    if (attempt <= maxAttempts && task.workerThreadId !== null) {
      const fixPrompt = `${ORCHESTRATOR_PREFIX} Independent verifier (@thread:${verifierThreadId}) rejected your work (attempt ${attempt}/${maxAttempts}).

Summary: ${result.summary}${issuesBlock}${checksBlock}

Verify each finding against the original task contract, fix real bugs, re-run tests, push if on a PR branch, and call ariadne_report(status="done") when ready.`;
      await steerOrRotateTask(task, fixPrompt, "continue", "orchestrator");
      return `Verification failed; routed findings back to worker (attempt ${attempt}/${maxAttempts}).`;
    }

    store.updateTask(task.id, { status: "blocked" });
    publish();
    await tellAriadne(
      ws.ariadne_thread_id,
      `${PLUGIN_PREFIX} Verification FAILED for ${task.id} (${task.title}) via @thread:${verifierThreadId} after ${attempt}/${maxAttempts} cycles. Task moved to blocked.\nSummary: ${result.summary}${issuesBlock}${checksBlock}`,
      verifierThreadId,
    );
    return `Verification failed; escalated to Ariadne (retries exhausted).`;
  }

  // ------------------------------------------------ worktree & branch cleanup

  /** What would be lost if this task's worktree disappeared, or null if nothing. */
  async function workAtRisk(task: Task): Promise<string | null> {
    const environmentId = await environmentIdFor(task);
    if (environmentId === null) return null;
    const env = await bb.sdk.environments.get({ environmentId });
    if (!env.managed || !env.isWorktree || env.path === null || env.lifecycle.phase === "destroyed") return null;
    const dirt = await worktreeDirt(env.path);
    if (dirt !== null) return `uncommitted changes in ${env.path}:\n${dirt}`;
    const branch = (await currentBranch(env.path)) ?? env.branchName;
    const baseRef = `refs/remotes/origin/${env.defaultBranch ?? "main"}`;
    if (branch !== null && !(await branchIsSafeToDelete(env.path, branch, baseRef))) {
      return `branch ${branch} has commits that are not pushed`;
    }
    return null;
  }

  /** Archives the worker and cancels active watches; BB then retires its worktree. */
  async function dropTask(taskId: string): Promise<string> {
    const task = store.task(taskId);
    if (task === undefined) throw new Error(`No task ${taskId}.`);
    store.updateTask(taskId, { status: "dropped" });
    store.cancelWatchesForTask(taskId);
    for (const run of store.runsForTask(taskId)) {
      if (run.role === "verifier" && run.status === "running") {
        store.updateRunByThread(run.threadId, { status: "failed", summary: "Task dropped", endedAt: Date.now() });
        await cleanupHiddenThread(run.threadId);
      }
    }
    if (task.workerThreadId !== null) {
      await bb.sdk.threads.archive({ threadId: task.workerThreadId }).catch((err: unknown) => {
        if (!isNotFound(err)) throw err;
      });
    }
    store.event("task-dropped", "", task.workstream, taskId);
    publish();
    kickReconciler();
    return `Dropped ${task.title}.`;
  }

  async function retireWorkerEnvironment(task: Task, notify = true) {
    const environmentId = await environmentIdFor(task);
    if (environmentId === null) return;
    const env = await bb.sdk.environments.get({ environmentId });
    if (!env.managed || !env.isWorktree || env.projectId === null) return;
    const source = await projectSource(env.projectId);
    if (source.path === null) return;
    const branch =
      env.path !== null && env.lifecycle.phase !== "destroyed" ? ((await currentBranch(env.path)) ?? env.branchName) : env.branchName;
    const risk = await workAtRisk(task);
    if (risk !== null) {
      store.event("worktree-at-risk", risk, task.workstream, task.id);
      const ws = notify ? store.workstream(task.workstream) : undefined;
      const when = env.lifecycle.retireAt === null ? "soon" : `at ${new Date(env.lifecycle.retireAt).toISOString()}`;
      if (ws !== undefined)
        await tellAriadne(
          ws.ariadne_thread_id,
          `${PLUGIN_PREFIX} Archived task ${task.id} (${task.title}) has ${risk}. BB removes its worktree ${when}; unarchiving @thread:${task.workerThreadId} keeps it. Tell the user now if the work matters.`,
        );
      if (risk.startsWith("branch")) return;
    }
    if (branch !== null) {
      store.queueBranchCleanup({
        environment_id: env.id,
        repo_path: source.path,
        branch,
        base_ref: `refs/remotes/origin/${env.defaultBranch ?? "main"}`,
      });
    }
    store.event("worktree-retiring", `${env.id} ${branch ?? ""}`, task.workstream, task.id);
  }

  async function processBranchCleanups() {
    for (const row of store.pendingBranchCleanups()) {
      try {
        const env = await bb.sdk.environments.get({ environmentId: row.environment_id });
        if (env.lifecycle.phase !== "destroyed") {
          store.bumpBranchCleanup(row.environment_id);
          if (row.attempts > 36) store.finishBranchCleanup(row.environment_id);
          continue;
        }
        if (
          (await branchExists(row.repo_path, row.branch)) &&
          (await branchIsSafeToDelete(row.repo_path, row.branch, row.base_ref))
        ) {
          await deleteBranch(row.repo_path, row.branch);
          store.event("branch-deleted", row.branch);
        }
        store.finishBranchCleanup(row.environment_id);
      } catch (error) {
        bb.log.warn(`branch cleanup ${row.branch} failed: ${String(error)}`);
        store.bumpBranchCleanup(row.environment_id);
      }
    }
  }

  function prSummary(result: Awaited<ReturnType<typeof bb.sdk.environments.pullRequest>>): PrSummary | null {
    if (result.outcome !== "available") return null;
    const pr = result.pullRequest;
    return {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      attention: pr.attention,
      checks: {
        state: pr.checks.state,
        passed: pr.checks.passedCount,
        failed: pr.checks.failedCount,
        pending: pr.checks.pendingCount,
      },
      updatedAt: pr.updatedAt ?? null,
      reviewState: pr.review?.state ?? null,
      mergeableState: pr.mergeability?.state ?? null,
    };
  }

  async function worktreeBranch(env: Awaited<ReturnType<typeof bb.sdk.environments.get>>): Promise<string | null> {
    return env.path === null ? env.branchName : ((await currentBranch(env.path)) ?? env.branchName);
  }

  async function refreshBranch(task: Task): Promise<void> {
    try {
      const environmentId = await environmentIdFor(task);
      if (environmentId === null) return;
      const env = await bb.sdk.environments.get({ environmentId });
      if (env.lifecycle.phase === "destroyed") return;
      const branch = await worktreeBranch(env);
      if (branch !== null) store.updateTask(task.id, { branch });
    } catch (error) {
      bb.log.warn(`branch refresh ${task.id} failed: ${String(error)}`);
    }
  }

  async function archiveOrphanedWorkstreams() {
    for (const ws of store.workstreams().filter((w) => w.archived_at === null)) {
      const gone = await bb.sdk.threads.get({ threadId: ws.ariadne_thread_id }).then(
        (thread) => thread.deletedAt !== null,
        isNotFound,
      );
      if (!gone) continue;
      store.archiveWorkstream(ws.name);
      store.cancelWatchesForWorkstream(ws.name);
      store.event("workstream-orphaned", ws.ariadne_thread_id, ws.name);
      publish();
    }
  }

  async function liveWorkers(tasks: Task[]): Promise<Task[]> {
    const live: Task[] = [];
    for (const task of tasks) {
      if (task.workerThreadId === null) continue;
      const thread = await bb.sdk.threads.get({ threadId: task.workerThreadId }).catch(() => null);
      if (thread !== null && thread.archivedAt === null && thread.deletedAt === null) live.push(task);
    }
    return live;
  }

  async function deletionPreview(name: string) {
    if (store.workstream(name) === undefined) throw new Error(`No workstream ${name}.`);
    const tasks = store.tasks(name);
    const risks: { taskId: string; title: string; risk: string }[] = [];
    for (const task of tasks) {
      const risk = await workAtRisk(task).catch(() => null);
      if (risk !== null) risks.push({ taskId: task.id, title: task.title, risk });
    }
    return {
      tasks: tasks.length,
      notes: store.notes(name, 0).length,
      liveWorkers: (await liveWorkers(tasks)).length,
      risks,
    };
  }

  const deleting = new Set<string>();

  async function deleteWorkstream(name: string): Promise<string> {
    const ws = store.workstream(name);
    if (ws === undefined) return `No workstream ${name}; nothing to delete.`;
    deleting.add(name);
    try {
      store.cancelWatchesForWorkstream(name);
      const tasks = store.tasks(name);
      for (const task of tasks) {
        for (const run of store.runsForTask(task.id)) {
          if (run.role === "verifier" && run.status === "running") {
            await cleanupHiddenThread(run.threadId);
          }
        }
      }
      const workers = await liveWorkers(tasks);
      for (const task of workers) {
        try {
          await bb.sdk.threads.archive({ threadId: task.workerThreadId! });
          await retireWorkerEnvironment(task, false);
        } catch (error) {
          bb.log.warn(`delete ${name}: retiring worker ${task.workerThreadId} failed: ${String(error)}`);
        }
      }
      let outcome: string;
      try {
        await bb.sdk.threads.delete({ threadId: ws.ariadne_thread_id, childThreadsConfirmed: true });
        outcome = "deleted";
      } catch (error) {
        if (isNotFound(error)) {
          outcome = "already gone";
        } else {
          bb.log.warn(`delete ${name}: deleting ${ws.ariadne_thread_id} failed, archiving: ${String(error)}`);
          await bb.sdk.threads.archive({ threadId: ws.ariadne_thread_id }).catch((archiveError: unknown) => {
            if (!isNotFound(archiveError)) throw archiveError;
          });
          outcome = "archived (delete failed)";
        }
      }
      store.deleteWorkstream(name);
      store.event("workstream-deleted", `${name} ${ws.ariadne_thread_id} ${outcome}, ${workers.length} workers archived`);
      publish();
      return `Deleted workstream ${name}: archived ${workers.length} live workers; Ariadne thread ${outcome}.`;
    } finally {
      deleting.delete(name);
    }
  }

  // ------------------------------------------------ control-plane reconciler

  async function evaluateActiveWatches(digest: Map<string, string[]>) {
    const add = (workstream: string, line: string) => digest.set(workstream, [...(digest.get(workstream) ?? []), line]);
    const watches = store.activeWatches();
    if (watches.length === 0) return false;
    let changed = false;

    const evalCtx = {
      now: Date.now(),
      getTask: (id: string) => store.task(id),
      getTaskPr: async (task: Task) => {
        const environmentId = await environmentIdFor(task);
        if (environmentId === null) return task.pr;
        try {
          const pr = prSummary(await bb.sdk.environments.pullRequest({ environmentId }));
          if (pr !== null) store.updateTask(task.id, { pr, prUrl: pr.url });
          return pr;
        } catch {
          return task.pr;
        }
      },
      fetchExternalPr: fetchGitHubPr,
      runCommand: async (task: Task, command: string) => {
        const environmentId = await environmentIdFor(task);
        const env = environmentId ? await bb.sdk.environments.get({ environmentId }).catch(() => null) : null;
        const ws = store.workstream(task.workstream);
        const fallbackPath = ws ? (await projectSource(ws.project_id).catch(() => null))?.path ?? process.cwd() : process.cwd();
        const cwd = env?.path ?? fallbackPath;
        return runCheckCommand(cwd, command);
      },
    };

    for (const watch of watches) {
      const task = store.task(watch.taskId);
      const ws = store.workstream(watch.workstream);
      if (task === undefined || ws === undefined || ws.archived_at !== null || task.status === "dropped" || task.status === "done") {
        store.updateWatch(watch.id, { status: "cancelled" });
        changed = true;
        continue;
      }
      try {
        const outcome = await evaluateWatch(watch, task, evalCtx);
        if (outcome.status === "pending") {
          store.updateWatch(watch.id, { lastCheckedAt: Date.now(), lastState: outcome.state });
          continue;
        }
        if (outcome.status === "expired") {
          store.updateWatch(watch.id, { status: "expired", lastCheckedAt: Date.now(), lastState: outcome.state });
          store.event("watch-expired", `${watch.id} ${watch.kind} ${watch.target}`, ws.name, task.id);
          const remaining = store.watchesForTask(task.id, true);
          if (task.status === "waiting" && remaining.length === 0) {
            store.updateTask(task.id, { status: "blocked" });
          }
          add(ws.name, `Watch ${watch.id} on ${task.id} (${task.title}) expired: ${outcome.detail}`);
          changed = true;
          continue;
        }
        // Triggered!
        store.updateWatch(watch.id, {
          status: "triggered",
          lastCheckedAt: Date.now(),
          lastState: outcome.state,
          triggeredAt: Date.now(),
        });
        store.event("watch-triggered", `${watch.id} ${watch.kind} ${watch.target}: ${outcome.detail}`, ws.name, task.id);
        changed = true;
        const wakePrompt = `${ORCHESTRATOR_PREFIX} Watch ${watch.id} triggered (${watch.kind} ${watch.target}).\n\nObserved: ${outcome.detail}\n\nNext step: ${watch.resumePrompt}`;
        if (task.workerThreadId !== null) {
          await steerOrRotateTask(task, wakePrompt, "continue", "orchestrator");
        } else {
          add(ws.name, `Watch ${watch.id} triggered for ${task.id} (${task.title}): ${outcome.detail}. Next: ${watch.resumePrompt}`);
        }
      } catch (error) {
        bb.log.warn(`watch ${watch.id} eval failed: ${String(error)}`);
        store.updateWatch(watch.id, { lastCheckedAt: Date.now(), lastState: `error: ${String(error).slice(0, 80)}` });
      }
    }
    return changed;
  }

  function cancelWatchById(watchId: string) {
    const watch = store.watch(watchId);
    if (watch === undefined) return null;
    store.updateWatch(watchId, { status: "cancelled" });
    store.event("watch-cancelled", watchId, watch.workstream, watch.taskId);
    const task = store.task(watch.taskId);
    if (task !== undefined && task.status === "waiting" && store.watchesForTask(task.id, true).length === 0) {
      store.updateTask(task.id, { status: "blocked" });
    }
    publish();
    kickReconciler();
    return watch;
  }

  async function reconcileOrphanedVerifiers() {
    const graceMs = 20_000;
    for (const run of store.runningVerifiers()) {
      if (Date.now() - run.startedAt < graceMs) continue;
      try {
        const thread = await bb.sdk.threads.get({ threadId: run.threadId });
        if (thread.status === "active" || thread.status === "starting" || thread.status === "pending") continue;
        const output = await bb.sdk.threads.output({ threadId: run.threadId }).catch(() => ({ output: null }));
        const summary = output.output?.trim().slice(0, 600) || `Verifier ended (${thread.status}) without calling ariadne_verify_verdict.`;
        await settleVerification(run.threadId, { passed: false, summary });
      } catch (error) {
        if (isNotFound(error)) {
          await settleVerification(run.threadId, { passed: false, summary: "Verifier thread disappeared before reporting." });
        }
      }
    }
  }

  async function dispatchQueuedTasks(digest: Map<string, string[]>) {
    const add = (workstream: string, line: string) => digest.set(workstream, [...(digest.get(workstream) ?? []), line]);
    const allTasks = store.allTasks().filter((t) => {
      const ws = store.workstream(t.workstream);
      return ws !== undefined && ws.archived_at === null;
    });
    const plan = planQueuedDispatch(allTasks, Math.max(1, Math.round(config.maxConcurrentWorkers)));
    let changed = false;

    for (const { task, droppedDeps } of plan.blockedByDropped) {
      const ids = droppedDeps.map((d) => d.id).join(",");
      if (store.digestChanged(`dep-drop:${task.id}`, ids)) {
        store.updateTask(task.id, { status: "blocked" });
        add(
          task.workstream,
          `Queued task ${task.id} (${task.title}) cannot start because dependency ${ids} was dropped. Update its dependencies or drop it.`,
        );
        changed = true;
      }
    }

    for (const task of plan.ready) {
      try {
        const { note } = await launchTaskWorker(task);
        store.event("queued-task-dispatched", note, task.workstream, task.id);
        changed = true;
      } catch (error) {
        bb.log.warn(`dispatch queued task ${task.id} failed: ${String(error)}`);
        if (store.digestChanged(`dispatch-err:${task.id}`, String(error).slice(0, 120))) {
          add(task.workstream, `Failed to dispatch queued task ${task.id} (${task.title}): ${String(error)}`);
        }
      }
    }
    return changed;
  }

  async function refreshActiveTasksAndReact(digest: Map<string, string[]>): Promise<boolean> {
    const add = (workstream: string, line: string) => digest.set(workstream, [...(digest.get(workstream) ?? []), line]);
    const active = store.activeTasks().filter((t) => {
      const ws = store.workstream(t.workstream);
      return ws !== undefined && ws.archived_at === null;
    });
    const policy = {
      autoReactCi: config.autoReactCi,
      autoReactConflicts: config.autoReactConflicts,
      autoReactReviews: config.autoReactReviews,
      maxReactionRetries: Math.max(0, Math.round(config.maxReactionRetries)),
    };
    let changed = false;

    for (const task of active) {
      try {
        let workerBusy = false;
        let threadUpdatedAt: number | null = null;
        if (task.workerThreadId !== null) {
          const thread = await bb.sdk.threads.get({ threadId: task.workerThreadId }).catch(() => null);
          if (thread !== null) {
            workerBusy = thread.status === "active" || thread.status === "starting";
            threadUpdatedAt = thread.updatedAt;
          }
          const tokens = await readContextTokens(task.workerThreadId);
          if (tokens !== null && tokens !== task.contextTokens) {
            store.updateTask(task.id, { contextTokens: tokens });
            store.updateRunByThread(task.workerThreadId, { contextTokens: tokens });
            changed = true;
          }
        }

        // Stuck check: only for `running` tasks (not `waiting`, `verifying`, `in-review`).
        if (task.status === "running" && task.workerThreadId !== null && !workerBusy && threadUpdatedAt !== null) {
          const idleMinutes = (Date.now() - threadUpdatedAt) / 60_000;
          if (idleMinutes >= config.stuckMinutes && store.digestChanged(`stuck:${task.id}`, String(threadUpdatedAt))) {
            add(
              task.workstream,
              `Worker @thread:${task.workerThreadId} (${task.id}) has been idle ${Math.round(idleMinutes)} min while its task is still running.`,
            );
          }
        }

        const environmentId = await environmentIdFor(task);
        if (environmentId === null) continue;
        const env = await bb.sdk.environments.get({ environmentId }).catch(() => null);
        if (env === null || env.lifecycle.phase === "destroyed") continue;
        const pr = prSummary(await bb.sdk.environments.pullRequest({ environmentId }));
        const branch = await worktreeBranch(env);
        store.updateTask(task.id, { pr, prUrl: pr?.url ?? task.prUrl, branch });
        if (pr === null) continue;

        // Clear transient CI/conflict counters once clean.
        if (pr.checks.state === "passing" && (task.reactionCounts.ci_failed ?? 0) > 0) {
          store.resetReaction(task.id, "ci_failed");
        }
        if (pr.attention !== "conflicts" && pr.mergeableState !== "conflicts" && (task.reactionCounts.conflicts ?? 0) > 0) {
          store.resetReaction(task.id, "conflicts");
        }

        const latestTask = store.task(task.id)!;
        const decision = decidePrReaction(latestTask, pr, workerBusy, policy);
        if (decision.kind === "none") continue;

        if (decision.kind === "mark-done") {
          store.updateTask(task.id, { status: "done" });
          store.cancelWatchesForTask(task.id);
          store.event("pr-merged", `PR #${pr.number} ${pr.url}`, task.workstream, task.id);
          if (store.digestChanged(`pr:${task.id}`, `merged:${pr.number}`)) {
            add(task.workstream, `PR #${pr.number} for ${task.id} (${task.title}) merged: ${pr.url}`);
          }
          changed = true;
          continue;
        }

        if (decision.kind === "auto-fix-ci") {
          if (!store.digestChanged(`react:${task.id}`, decision.signature)) continue;
          store.bumpReaction(task.id, decision.reactionKey);
          store.event("reaction-ci-fix", `attempt ${decision.attempt}/${decision.maxAttempts} PR #${pr.number}`, task.workstream, task.id);
          const msg = `${ORCHESTRATOR_PREFIX} Automatic CI recovery (attempt ${decision.attempt}/${decision.maxAttempts}): PR #${pr.number} (${pr.url}) has ${pr.checks.failed} failing check(s). Inspect the failing checks, fix the root cause (do not mask flaky infra failures; report blocked if it is pure CI infra), verify locally, push, and call ariadne_report.`;
          await steerOrRotateTask(latestTask, msg, "fix-ci", "orchestrator");
          changed = true;
          continue;
        }

        if (decision.kind === "auto-rebase") {
          if (!store.digestChanged(`react:${task.id}`, decision.signature)) continue;
          store.bumpReaction(task.id, decision.reactionKey);
          store.event("reaction-rebase", `attempt ${decision.attempt}/${decision.maxAttempts} PR #${pr.number}`, task.workstream, task.id);
          const msg = `${ORCHESTRATOR_PREFIX} Automatic conflict recovery (attempt ${decision.attempt}/${decision.maxAttempts}): PR #${pr.number} (${pr.url}) has merge conflicts with its base branch. Merge or rebase onto the latest base branch, resolve conflicts carefully, run tests, push, and call ariadne_report.`;
          await steerOrRotateTask(latestTask, msg, "rebase", "orchestrator");
          changed = true;
          continue;
        }

        if (decision.kind === "auto-review-feedback") {
          if (!store.digestChanged(`react:${task.id}`, decision.signature)) continue;
          store.bumpReaction(task.id, decision.reactionKey);
          store.event("reaction-review", `attempt ${decision.attempt}/${decision.maxAttempts} PR #${pr.number}`, task.workstream, task.id);
          const msg = `${ORCHESTRATOR_PREFIX} Automatic review follow-up (attempt ${decision.attempt}/${decision.maxAttempts}): PR #${pr.number} (${pr.url}) has changes requested. Read the review comments, address code feedback cleanly, run tests, push (do not post external PR comments without approval), and report a summary via ariadne_report.`;
          await steerOrRotateTask(latestTask, msg, "review-feedback", "orchestrator");
          changed = true;
          continue;
        }

        if (decision.kind === "escalate") {
          if (store.digestChanged(`pr:${task.id}`, decision.signature)) {
            add(
              task.workstream,
              `${task.id} (${task.title}): ${decision.reason} If this reflects a repeatable pattern, consider updating bb memory, AGENTS.md, or recommending a workflow change.`,
            );
          }
        }
      } catch (error) {
        bb.log.warn(`reconcile task ${task.id} failed: ${String(error)}`);
      }
    }
    return changed;
  }

  async function compactHeavyManagers() {
    if (config.managerCompactTokens <= 0) return;
    for (const ws of store.workstreams().filter((w) => w.archived_at === null)) {
      try {
        const thread = await bb.sdk.threads.get({ threadId: ws.ariadne_thread_id }).catch(() => null);
        if (thread === null || thread.status !== "idle") continue;
        const tokens = await readContextTokens(ws.ariadne_thread_id);
        if (!shouldCompactManager(tokens, config.managerCompactTokens)) continue;
        const bucket = String(Math.floor((tokens ?? 0) / 20_000));
        if (!store.digestChanged(`compact:${ws.name}`, bucket)) continue;
        await bb.sdk.threads.compact({ threadId: ws.ariadne_thread_id });
        store.event("manager-compacted", `${ws.ariadne_thread_id} at ${tokens} tokens`, ws.name);
      } catch (error) {
        bb.log.warn(`auto-compact manager ${ws.name} failed: ${String(error)}`);
      }
    }
  }

  let activeReconcile: Promise<void> | null = null;
  let pendingReconcile = false;

  async function reconcileOnce(): Promise<void> {
    if (activeReconcile !== null) {
      pendingReconcile = true;
      return activeReconcile;
    }
    activeReconcile = (async () => {
      try {
        await processBranchCleanups();
        await archiveOrphanedWorkstreams();
        await syncWorkstreamChildren();
        await reconcileOrphanedVerifiers();

        const digest = new Map<string, string[]>();
        const add = (workstream: string, line: string) => digest.set(workstream, [...(digest.get(workstream) ?? []), line]);

        let changed = false;
        // Watches ALWAYS run, even during dormant windows, so waiting tasks never stall.
        if (await evaluateActiveWatches(digest)) changed = true;

        const hasActiveWork =
          Date.now() - lastActivityAt <= config.dormantMinutes * 60_000 ||
          store.activeTasks().length > 0 ||
          store.allTasks().some((t) => t.status === "queued");

        if (hasActiveWork) {
          if (await refreshActiveTasksAndReact(digest)) changed = true;
          if (await dispatchQueuedTasks(digest)) changed = true;

          for (const task of store.unharvestedDone()) {
            if (store.digestChanged(`harvest:${task.id}`, String(task.updatedAt))) {
              add(
                task.workstream,
                `Task ${task.id} (${task.title}) is done and unharvested: update notes, promote durable learnings to bb memory, and check if an AGENTS.md update or workflow improvement would prevent any friction it hit.`,
              );
            }
          }
          const recent = store.staging(50, Date.now() - 60 * 60_000);
          for (const entry of recent) {
            const overlap = recent.find((o) => o.service === entry.service && o.workstream !== entry.workstream);
            if (overlap !== undefined && store.digestChanged(`staging:${entry.id}`, String(overlap.id))) {
              add(
                entry.workstream,
                `Staging overlap on ${entry.service}: ${entry.branch} (${entry.workstream}) and ${overlap.branch} (${overlap.workstream}) within the last hour.`,
              );
            }
          }
        }

        await compactHeavyManagers();

        for (const [workstream, lines] of digest) {
          const ws = store.workstream(workstream);
          if (ws === undefined || ws.archived_at !== null || lines.length === 0) continue;
          await tellAriadne(ws.ariadne_thread_id, `${PLUGIN_PREFIX} Orchestrator update:\n- ${lines.join("\n- ")}`);
          markActivity();
        }
        if (changed || digest.size > 0) publish();
      } finally {
        activeReconcile = null;
        if (pendingReconcile) {
          pendingReconcile = false;
          void reconcileOnce();
        }
      }
    })();
    return activeReconcile;
  }

  bb.background.service("reconciler", {
    async start(signal) {
      let unsubscribe: (() => void) | null = null;
      if (typeof bb.sdk.subscribe === "function") {
        try {
          unsubscribe = bb.sdk.subscribe({
            event: "thread:changed",
            callback(event) {
              const id = event.id;
              if (id === undefined) return;
              const parentChanged =
                event.changes.includes("parent-changed") || event.changes.includes("thread-created");
              const titleChanged = event.changes.includes("title-changed");
              if (!parentChanged && !titleChanged) return;
              void (async () => {
                if (parentChanged) await reconcileThreadParentChange(id);
                if (titleChanged) await reconcileThreadTitleChange(id);
              })();
            },
          });
        } catch (error) {
          bb.log.warn(`thread:changed subscribe failed: ${String(error)}`);
        }
      }
      try {
        while (!signal.aborted) {
          try {
            await reconcileOnce();
          } catch (error) {
            bb.log.warn(`reconciler tick failed: ${String(error)}`);
          }
          const intervalMs = Math.max(10, Math.round(config.reconcileSeconds)) * 1000;
          await sleepOrWake(intervalMs, signal);
        }
      } finally {
        unsubscribe?.();
      }
    },
  });

  // ------------------------------------------------------------ view helpers

  async function workstreamView(row: WorkstreamRow): Promise<Workstream> {
    return {
      name: row.name,
      title: store.workstreamTitle(row),
      ariadneThreadId: row.ariadne_thread_id,
      projectId: row.project_id,
      projectName: await projectName(row.project_id),
      links: store.links(row),
      archived: row.archived_at !== null,
      ariadneExecution: store.ariadneExecution(row),
      workerExecution: store.workerExecution(row),
      counts: store.counts(row.name),
    };
  }

  function boardTasks(workstream: string): BoardTask[] {
    return store.tasks(workstream).map((task) => {
      const runs = store.runsForTask(task.id);
      const watches = store.watchesForTask(task.id);
      const attention = computeTaskAttention(task, watches, runs);
      return {
        ...task,
        attention: attention.lane,
        attentionReason: attention.reason,
        runs,
        watches,
      };
    });
  }

  // ------------------------------------------------------------ agent setup

  bb.agents.configure((context) => {
    const ws = store.workstreamByAriadne(context.thread.id);
    if (ws !== undefined && ws.archived_at === null) {
      return {
        tools: [
          "ariadne_spawn_worker",
          "ariadne_board",
          "ariadne_task_update",
          "ariadne_steer",
          "ariadne_inspect",
          "ariadne_verify",
          "ariadne_watch",
          "ariadne_watch_cancel",
          "ariadne_session",
          "ariadne_adopt_worker",
          "ariadne_detach_worker",
          "ariadne_drop_task",
          "ariadne_notes_read",
          "ariadne_notes_write",
          "ariadne_staging",
          ...(config.pluginProjectId === "" ? [] : ["ariadne_improve"]),
        ],
        skills: [],
        instructions: ariadneInstructions({
          workstream: store.workstreamTitle(ws),
          links: store.links(ws),
          projectName: projectNames.get(ws.project_id) ?? context.project.name,
          pluginCheckout,
        }),
      };
    }

    const run = store.runByThread(context.thread.id);
    const meta = context.pluginMetadata as AriadneMetadata;
    if (run?.role === "verifier" || (run === undefined && meta.role === "verifier" && typeof meta.taskId === "string")) {
      const task = store.task(run?.taskId ?? String(meta.taskId));
      return {
        tools: ["ariadne_verify_verdict"],
        skills: [],
        instructions: verifierInstructions({
          taskId: task?.id ?? String(meta.taskId ?? "unknown"),
          workstream: task?.workstream ?? String(meta.workstream ?? "unknown"),
        }),
      };
    }

    const task = store.activeTaskByWorker(context.thread.id);
    if (task !== undefined || (meta.role === "worker" && typeof meta.ariadneThreadId === "string")) {
      const wsForTask = task ? store.workstream(task.workstream) : undefined;
      if (wsForTask === undefined || wsForTask.archived_at === null) {
        const ariadneId = wsForTask?.ariadne_thread_id ?? String(meta.ariadneThreadId ?? "");
        if (ariadneId !== "") {
          return {
            tools: ["ariadne_report", "ariadne_watch", "ariadne_staging_log"],
            skills: [],
            instructions: workerInstructions({
              ariadneThreadId: ariadneId,
              taskId: task?.id ?? String(meta.taskId ?? "unknown"),
              branchConvention: context.project.id === config.pluginProjectId ? "" : config.branchConvention,
            }),
          };
        }
      }
    }

    // Ordinary visible non-fork threads receive the opt-in skill to become an Ariadne manager thread.
    if (context.origin.kind === null) {
      return { tools: [], skills: ["ariadne-orchestrate"] };
    }
    return { tools: [], skills: [] };
  });

  bb.agents.contributeInstructions(({ threadId }) => {
    const ws = store.workstreamByAriadne(threadId);
    return ws === undefined || ws.archived_at !== null ? null : MEMORY_INSTRUCTIONS;
  });

  async function requireAriadne(threadId: string): Promise<WorkstreamRow | string> {
    const ws = store.workstreamByAriadne(threadId);
    if (ws === undefined || ws.archived_at !== null) return "Only an active Ariadne manager thread can use this tool.";
    return ws;
  }

  bb.agents.registerTool({
    name: "ariadne_spawn_worker",
    description:
      "Create a task and spawn a nested worker in its own worktree, or queue it when dependsOn is unfinished or the concurrency cap is reached.",
    presentation: { label: { pending: "Spawning worker", completed: "Spawned worker" } },
    parameters: z.object({
      title: z.string().min(1).max(120).describe("Short task title, e.g. 'CHATINTS-2414 notify on join'"),
      prompt: z.string().min(1).describe("The full kickoff prompt and definition of done for the worker"),
      links: z.array(z.string()).max(20).optional().describe("Ticket or doc URLs for the board"),
      dependsOn: z.array(z.string()).max(20).optional().describe("Upstream task IDs that must finish before this task starts"),
      dependsMode: z.enum(DEPENDS_MODES).optional().describe("'done' (default) waits for upstream done/merged; 'pr-opened' unblocks once upstream has a PR"),
      verifyMode: z.enum(VERIFY_MODES).optional().describe("Clean-context verifier policy: 'auto' (default), 'always', or 'off'"),
      queueOnly: z.boolean().optional().describe("Queue without starting immediately"),
      providerId: z.string().optional().describe("Provider override for this worker"),
      model: z.string().optional().describe("Model override for this worker"),
      reasoningLevel: z.enum(REASONING_LEVELS).optional().describe("Reasoning level override for this worker"),
      serviceTier: z.string().optional().describe("Service tier override for this worker"),
      baseBranch: z.string().optional().describe("Base branch to fork from; defaults to repo default branch or single pr-opened dependency branch"),
    }),
    async execute(args, { threadId }) {
      const ws = await requireAriadne(threadId);
      if (typeof ws === "string") return errorText(ws);
      try {
        const { task, queued, note } = await spawnOrQueueWorker(threadId, args);
        if (queued) return `Queued task ${task.id} (${task.title}); ${note}.`;
        return `Spawned worker @thread:${task.workerThreadId} for task ${task.id} (${task.title}); ${note}.`;
      } catch (error) {
        return errorText(error instanceof Error ? error.message : String(error));
      }
    },
  });

  bb.agents.registerTool({
    name: "ariadne_board",
    description: "List this workstream's tasks with status, dependencies, watches, context usage, worker thread, branch and PR state.",
    presentation: { label: { pending: "Reading board", completed: "Read board" }, suppress: true },
    parameters: z.object({ status: z.enum(TASK_STATUSES).optional() }),
    async execute({ status }, { threadId }) {
      const ws = await requireAriadne(threadId);
      if (typeof ws === "string") return errorText(ws);
      const tasks = store.tasks(ws.name, status);
      if (tasks.length === 0) return "No tasks.";
      return tasks
        .map((t) =>
          boardRow(t, true, {
            watches: store.watchesForTask(t.id, true),
            runs: store.runsForTask(t.id),
          }),
        )
        .join("\n");
    },
  });

  bb.agents.registerTool({
    name: "ariadne_task_update",
    description: "Update a task on the board (status, PR URL, summary, handoff, harvested, dependencies, or verifyMode).",
    presentation: { label: { pending: "Updating task", completed: "Updated task" } },
    parameters: z.object({
      taskId: z.string(),
      status: z.enum(TASK_STATUSES).optional(),
      prUrl: z.string().optional(),
      summary: z.string().max(2000).optional(),
      handoff: z.string().max(6000).optional(),
      harvested: z.boolean().optional(),
      dependsOn: z.array(z.string()).max(20).optional(),
      dependsMode: z.enum(DEPENDS_MODES).optional(),
      verifyMode: z.enum(VERIFY_MODES).optional(),
    }),
    async execute({ taskId, dependsOn, ...changes }, { threadId }) {
      const ws = await requireAriadne(threadId);
      if (typeof ws === "string") return errorText(ws);
      const task = store.task(taskId);
      if (task === undefined || task.workstream !== ws.name) return errorText(`No task ${taskId} in this workstream.`);
      if (dependsOn !== undefined) {
        const wsTasks = store.tasks(ws.name);
        for (const depId of dependsOn) {
          if (!wsTasks.some((t) => t.id === depId)) return errorText(`Dependency ${depId} not found in workstream "${ws.name}".`);
        }
        const cycle = findDependencyCycle(wsTasks, taskId, dependsOn);
        if (cycle !== null) return errorText(`Dependency cycle rejected: ${cycle.join(" -> ")}.`);
      }
      store.updateTask(taskId, { ...changes, ...(dependsOn !== undefined ? { dependsOn } : {}) });
      store.event("task-updated", JSON.stringify({ ...changes, ...(dependsOn !== undefined ? { dependsOn } : {}) }), ws.name, taskId);
      publish();
      kickReconciler();
      return `Updated ${taskId}.`;
    },
  });

  bb.agents.registerTool({
    name: "ariadne_steer",
    description:
      "Control or steer a task's worker directly (no bash bb thread tell): send instructions, rotate to a fresh nested run on the same worktree, switch model/reasoning live, stop, compact, or dispatch a queued task now.",
    presentation: { label: { pending: "Steering worker", completed: "Steered worker" } },
    parameters: z.object({
      taskId: z.string(),
      message: z.string().max(8000).optional().describe("Instructions to send (required for steer/rotate unless only switching model/reasoning)"),
      action: z.enum(["steer", "rotate", "stop", "compact", "dispatch"]).optional().describe("Default 'steer' (or 'rotate' when rotate=true)"),
      rotate: z.boolean().optional().describe("Shorthand for action='rotate': start a fresh-context worker run on the same worktree"),
      model: z.string().optional().describe("Live model override for the worker thread (same provider)"),
      reasoningLevel: z.enum(REASONING_LEVELS).optional().describe("Live reasoning level override for the worker thread"),
    }),
    async execute({ taskId, message, action, rotate, model, reasoningLevel }, { threadId }) {
      const ws = await requireAriadne(threadId);
      if (typeof ws === "string") return errorText(ws);
      const task = store.task(taskId);
      if (task === undefined || task.workstream !== ws.name) return errorText(`No task ${taskId} in this workstream.`);
      const mode = action ?? (rotate ? "rotate" : "steer");
      try {
        if (mode === "dispatch") {
          if (task.status !== "queued") return errorText(`Task ${taskId} is ${task.status}, not queued.`);
          const { task: launched, note } = await launchTaskWorker(task);
          return `Dispatched queued task ${taskId} on @thread:${launched.workerThreadId}; ${note}.`;
        }
        if (mode === "stop") {
          if (task.workerThreadId === null) return errorText(`Task ${taskId} has no active worker thread.`);
          await bb.sdk.threads.stop({ threadId: task.workerThreadId });
          store.event("worker-stopped", task.workerThreadId, ws.name, taskId);
          return `Stopped worker @thread:${task.workerThreadId} for ${taskId}.`;
        }
        if (mode === "compact") {
          if (task.workerThreadId === null) return errorText(`Task ${taskId} has no active worker thread.`);
          await bb.sdk.threads.compact({ threadId: task.workerThreadId });
          store.event("worker-compacted", task.workerThreadId, ws.name, taskId);
          return `Requested compaction for worker @thread:${task.workerThreadId} (${taskId}).`;
        }

        const updates: string[] = [];
        if (model !== undefined || reasoningLevel !== undefined) {
          const nextExec = mergeExecution(task.execution, {
            ...(model !== undefined ? { model } : {}),
            ...(reasoningLevel !== undefined ? { reasoningLevel } : {}),
          });
          store.updateTask(taskId, { execution: nextExec });
          if (task.workerThreadId !== null) {
            await bb.sdk.threads.update({
              threadId: task.workerThreadId,
              ...(model !== undefined ? { model } : {}),
              ...(reasoningLevel !== undefined ? { reasoningLevel } : {}),
            });
          }
          updates.push(
            `updated execution (${[model ? `model=${model}` : null, reasoningLevel ? `reasoning=${reasoningLevel}` : null].filter(Boolean).join(", ")})`,
          );
        }

        const trimmed = message?.trim() ?? "";
        if (trimmed === "" && mode === "steer") {
          if (updates.length > 0) {
            publish();
            return `Updated ${taskId}: ${updates.join("; ")}.`;
          }
          return errorText("Pass message, model/reasoningLevel, or an action (rotate/stop/compact/dispatch).");
        }

        const latestTask = store.task(taskId)!;
        const promptText = trimmed || "Continue from the current worktree state and latest handoff.";
        const res = await steerOrRotateTask(latestTask, promptText, mode === "rotate" ? "rotate" : "continue", "ariadne", {
          forceRotate: mode === "rotate",
          senderThreadId: threadId,
        });
        const prefix = updates.length > 0 ? `${updates.join("; ")}; ` : "";
        return res.rotated
          ? `${prefix}Rotated ${taskId} to fresh worker @thread:${res.threadId} on the same worktree.`
          : `${prefix}Steered @thread:${res.threadId} for ${taskId}.`;
      } catch (error) {
        return errorText(error instanceof Error ? error.message : String(error));
      }
    },
  });

  bb.agents.registerTool({
    name: "ariadne_session",
    description:
      "Control this Ariadne manager session and workstream from chat: inspect status/context, list available models, change your own model/reasoning/title/pin, compact or clear your context, update workstream worker defaults/links, tune orchestrator settings live, or detach back to a normal thread.",
    presentation: { label: { pending: "Updating Ariadne session", completed: "Updated Ariadne session" } },
    parameters: z.object({
      action: z.enum(["status", "models", "update", "compact", "clear-context", "set-defaults", "set-config", "detach"]),
      providerId: z.string().optional().describe("For models: filter to one provider id"),
      model: z.string().optional().describe("For update: new model id for this Ariadne thread"),
      reasoningLevel: z.enum(REASONING_LEVELS).optional().describe("For update: new reasoning level for this Ariadne thread"),
      title: z.string().max(120).optional().describe("For update: new display title for this Ariadne thread and workstream"),
      pinned: z.boolean().optional().describe("For update: pin or unpin this Ariadne thread"),
      workerProviderId: z.string().nullable().optional().describe("For set-defaults: default provider for new workers"),
      workerModel: z.string().nullable().optional().describe("For set-defaults: default model for new workers"),
      workerReasoningLevel: z.enum(REASONING_LEVELS).nullable().optional().describe("For set-defaults: default reasoning level for new workers"),
      workerServiceTier: z.string().nullable().optional().describe("For set-defaults: default service tier for new workers"),
      resetWorkerDefaults: z.boolean().optional().describe("For set-defaults: clear workstream worker overrides back to plugin/BB defaults"),
      addLinks: z.array(z.string()).max(20).optional().describe("For set-defaults: append ticket/doc URLs to the workstream"),
      removeLinks: z.array(z.string()).max(20).optional().describe("For set-defaults: remove URLs from the workstream"),
      configPatch: z
        .object({
          maxConcurrentWorkers: z.number().int().min(1).max(20).optional(),
          reconcileSeconds: z.number().int().min(10).max(3600).optional(),
          autoReactCi: z.boolean().optional(),
          autoReactConflicts: z.boolean().optional(),
          autoReactReviews: z.boolean().optional(),
          maxReactionRetries: z.number().int().min(0).max(10).optional(),
          verifyByDefault: z.boolean().optional(),
          maxVerifyRetries: z.number().int().min(0).max(10).optional(),
          workerRotateTokens: z.number().int().min(0).max(1_000_000).optional(),
          managerCompactTokens: z.number().int().min(0).max(1_000_000).optional(),
          stuckMinutes: z.number().int().min(5).max(1440).optional(),
          dormantMinutes: z.number().int().min(5).max(1440).optional(),
        })
        .optional()
        .describe("For set-config: orchestrator plugin settings to update live"),
    }),
    async execute(args, { threadId }) {
      const ws = await requireAriadne(threadId);
      if (typeof ws === "string") return errorText(ws);
      try {
        if (args.action === "status") {
          const [thread, execOpts, tokens] = await Promise.all([
            bb.sdk.threads.get({ threadId }).catch(() => null),
            bb.sdk.threads.defaultExecutionOptions({ threadId }).catch(() => null),
            readContextTokens(threadId),
          ]);
          const displayTitle = store.workstreamTitle(ws);
          const lines = [
            `Workstream: ${displayTitle}${displayTitle !== ws.name ? ` (id: ${ws.name})` : ""} (thread @thread:${threadId})`,
            `Session: provider=${thread?.providerId ?? "?"} model=${execOpts?.model ?? "?"} reasoning=${execOpts?.reasoningLevel ?? "?"} tier=${execOpts?.serviceTier ?? "default"} pinned=${thread?.pinnedAt !== null && thread?.pinnedAt !== undefined}`,
            `Context: ${tokens !== null ? `${tokens.toLocaleString()} tokens` : "unknown"} (auto-compact at ${config.managerCompactTokens.toLocaleString()})`,
            `Workstream worker defaults: ${JSON.stringify(store.workerExecution(ws))}`,
            `Links: ${store.links(ws).join(", ") || "none"}`,
            `Orchestrator config: maxConcurrentWorkers=${config.maxConcurrentWorkers}, reconcileSeconds=${config.reconcileSeconds}, verifyByDefault=${config.verifyByDefault} (maxVerifyRetries=${config.maxVerifyRetries}), autoReactCi=${config.autoReactCi}, autoReactConflicts=${config.autoReactConflicts}, autoReactReviews=${config.autoReactReviews} (maxReactionRetries=${config.maxReactionRetries}), workerRotateTokens=${config.workerRotateTokens}`,
          ];
          return lines.join("\n");
        }

        if (args.action === "models") {
          const thread = await bb.sdk.threads.get({ threadId }).catch(() => null);
          const providers = await bb.sdk.providers.list().catch(() => []);
          const targetProvider = args.providerId ?? thread?.providerId ?? providers[0]?.id;
          const lines: string[] = [];
          if (providers.length > 0) {
            lines.push(`Providers: ${providers.map((p) => `${p.id} (${p.displayName})`).join(", ")}`);
          }
          if (targetProvider) {
            const catalog = await bb.sdk.providers.models({ providerId: targetProvider });
            lines.push(`Models for ${targetProvider}:`);
            for (const m of catalog.models) {
              const efforts = m.supportedReasoningEfforts.map((e) => e.reasoningEffort).join(",");
              const tiers = (m.supportedServiceTiers ?? []).map((t) => t.id).join(",");
              lines.push(
                `  - ${m.model}${m.isDefault ? " (default)" : ""} [${m.displayName}] reasoning=[${efforts}]${tiers ? ` tiers=[${tiers}]` : ""}`,
              );
            }
          }
          return lines.length === 0 ? "No provider/model catalog available." : lines.join("\n");
        }

        if (args.action === "update") {
          const changes: string[] = [];
          const patch: { model?: string; reasoningLevel?: ReasoningLevel; title?: string } = {};
          let nextDisplayTitle: string | undefined;
          if (args.model !== undefined) patch.model = args.model;
          if (args.reasoningLevel !== undefined) patch.reasoningLevel = args.reasoningLevel;
          if (args.title !== undefined) {
            nextDisplayTitle = (stripMark(args.title, ARIADNE_MARK) || store.workstreamTitle(ws)).slice(0, 120);
            patch.title = `${ARIADNE_MARK} ${nextDisplayTitle}`;
          }
          if (Object.keys(patch).length > 0) {
            syncingThreads.add(threadId);
            try {
              await bb.sdk.threads.update({ threadId, ...patch });
            } finally {
              syncingThreads.delete(threadId);
            }
            changes.push(
              Object.entries(patch)
                .map(([k, v]) => `${k}=${v}`)
                .join(", "),
            );
          }
          if (nextDisplayTitle !== undefined) {
            store.updateWorkstream(ws.name, { title: nextDisplayTitle });
          }
          if (args.model !== undefined || args.reasoningLevel !== undefined) {
            const nextExec = mergeExecution(store.ariadneExecution(ws), {
              ...(args.model !== undefined ? { model: args.model } : {}),
              ...(args.reasoningLevel !== undefined ? { reasoningLevel: args.reasoningLevel } : {}),
            });
            store.updateWorkstream(ws.name, { ariadneExecution: nextExec });
          }
          if (args.pinned === true) {
            await bb.sdk.threads.pin({ threadId });
            changes.push("pinned=true");
          } else if (args.pinned === false) {
            await bb.sdk.threads.unpin({ threadId });
            changes.push("pinned=false");
          }
          if (changes.length === 0) return errorText("Pass model, reasoningLevel, title, or pinned to update.");
          store.event("session-updated", changes.join(", "), ws.name);
          publish();
          return `Updated Ariadne session: ${changes.join(", ")}. Model/reasoning changes apply starting on the next turn.`;
        }

        if (args.action === "compact" || args.action === "clear-context") {
          const tokens = await readContextTokens(threadId);
          pendingSessionActions.set(threadId, { kind: args.action });
          store.event(`session-${args.action}-queued`, tokens !== null ? `${tokens} tokens` : "", ws.name);
          return `Scheduled ${args.action} for this Ariadne thread once your current turn finishes (${tokens !== null ? `${tokens.toLocaleString()} tokens currently used` : "current usage unknown"}). End your turn cleanly.`;
        }

        if (args.action === "set-defaults") {
          const notes: string[] = [];
          if (args.resetWorkerDefaults) {
            store.updateWorkstream(ws.name, { workerExecution: null });
            notes.push("reset worker defaults");
          } else if (
            args.workerProviderId !== undefined ||
            args.workerModel !== undefined ||
            args.workerReasoningLevel !== undefined ||
            args.workerServiceTier !== undefined
          ) {
            const nextWorker = mergeExecution(store.workerExecution(ws), {
              ...(args.workerProviderId !== undefined ? { providerId: args.workerProviderId } : {}),
              ...(args.workerModel !== undefined ? { model: args.workerModel } : {}),
              ...(args.workerReasoningLevel !== undefined ? { reasoningLevel: args.workerReasoningLevel } : {}),
              ...(args.workerServiceTier !== undefined ? { serviceTier: args.workerServiceTier } : {}),
            });
            store.updateWorkstream(ws.name, { workerExecution: nextWorker });
            notes.push(`workerDefaults=${JSON.stringify(nextWorker)}`);
          }
          if (args.addLinks || args.removeLinks) {
            const removeSet = new Set((args.removeLinks ?? []).map((l) => l.trim()));
            const merged = [...store.links(ws).filter((l) => !removeSet.has(l))];
            for (const link of args.addLinks ?? []) {
              const trimmed = link.trim();
              if (trimmed && !merged.includes(trimmed)) merged.push(trimmed);
            }
            store.updateWorkstream(ws.name, { links: merged });
            notes.push(`links=${merged.length}`);
          }
          if (notes.length === 0) return errorText("Specify worker defaults or link changes.");
          store.event("workstream-defaults-updated", notes.join("; "), ws.name);
          publish();
          return `Updated workstream "${ws.name}": ${notes.join("; ")}.`;
        }

        if (args.action === "set-config") {
          if (!args.configPatch || Object.keys(args.configPatch).length === 0) {
            return errorText("Pass configPatch with at least one orchestrator setting.");
          }
          config = await settings.experimental_set(args.configPatch);
          store.event("config-updated", JSON.stringify(args.configPatch), ws.name);
          kickReconciler();
          return `Updated orchestrator settings: ${JSON.stringify(args.configPatch)}.`;
        }

        // detach
        return await detachWorkstream(ws.name);
      } catch (error) {
        return errorText(error instanceof Error ? error.message : String(error));
      }
    },
  });

  bb.agents.registerTool({
    name: "ariadne_adopt_worker",
    description:
      "Pull an existing normal BB thread into this workstream as a tracked nested worker subthread (reparents under Ariadne, adds board tracking, PR/CI reactions, and worker tools).",
    presentation: { label: { pending: "Adopting thread as worker", completed: "Adopted thread as worker" } },
    parameters: z.object({
      threadId: z.string().min(1).describe("The existing BB thread id to adopt as a worker subthread"),
      title: z.string().max(120).optional().describe("Optional task title override"),
      links: z.array(z.string()).max(20).optional().describe("Optional ticket or doc URLs"),
    }),
    async execute({ threadId: targetThreadId, title, links }, { threadId }) {
      const ws = await requireAriadne(threadId);
      if (typeof ws === "string") return errorText(ws);
      try {
        const { task, alreadyTracked } = await adoptWorkerThread(ws.name, targetThreadId, {
          title,
          links,
          reparent: true,
          notifyAriadne: false,
        });
        return alreadyTracked
          ? `Thread @thread:${targetThreadId} is already tracked as task ${task.id} (${task.title}).`
          : `Adopted @thread:${targetThreadId} as task ${task.id} (${task.title}) in "${ws.name}".`;
      } catch (error) {
        return errorText(error instanceof Error ? error.message : String(error));
      }
    },
  });

  bb.agents.registerTool({
    name: "ariadne_detach_worker",
    description:
      "Release a tracked worker subthread out of this workstream into a normal standalone BB thread (keeps the thread alive, removes parentThreadId and worker tools, cancels watches).",
    presentation: { label: { pending: "Detaching worker thread", completed: "Detached worker thread" } },
    parameters: z.object({
      taskId: z.string().min(1),
    }),
    async execute({ taskId }, { threadId }) {
      const ws = await requireAriadne(threadId);
      if (typeof ws === "string") return errorText(ws);
      const task = store.task(taskId);
      if (task === undefined || task.workstream !== ws.name) return errorText(`No task ${taskId} in this workstream.`);
      try {
        return await detachWorkerTask(taskId, { reparentToNull: true, notifyAriadne: false });
      } catch (error) {
        return errorText(error instanceof Error ? error.message : String(error));
      }
    },
  });

  bb.agents.registerTool({
    name: "ariadne_drop_task",
    description:
      "Drop a task, cancel its watches, and archive its worker thread (retiring its worktree). Refuses if uncommitted or unpushed work exists unless force=true.",
    presentation: { label: { pending: "Dropping task", completed: "Dropped task" } },
    parameters: z.object({
      taskId: z.string().min(1),
      force: z.boolean().optional().describe("Set true only after confirming with the user if uncommitted/unpushed work is at risk"),
    }),
    async execute({ taskId, force }, { threadId }) {
      const ws = await requireAriadne(threadId);
      if (typeof ws === "string") return errorText(ws);
      const task = store.task(taskId);
      if (task === undefined || task.workstream !== ws.name) return errorText(`No task ${taskId} in this workstream.`);
      try {
        if (!force) {
          const risk = await workAtRisk(task).catch(() => null);
          if (risk !== null) {
            return errorText(
              `Refused to drop ${taskId} (${task.title}) because work is at risk: ${risk}. Confirm with the user and call again with force=true (or detach it with ariadne_detach_worker instead).`,
            );
          }
        }
        return await dropTask(taskId);
      } catch (error) {
        return errorText(error instanceof Error ? error.message : String(error));
      }
    },
  });

  bb.agents.registerTool({
    name: "ariadne_inspect",
    description:
      "Inspect a task's live facts: worker status, context tokens, last output, diff files, run history, active watches and PR status.",
    presentation: { label: { pending: "Inspecting task", completed: "Inspected task" }, suppress: true },
    parameters: z.object({ taskId: z.string() }),
    async execute({ taskId }, { threadId }) {
      const ws = await requireAriadne(threadId);
      if (typeof ws === "string") return errorText(ws);
      const task = store.task(taskId);
      if (task === undefined || task.workstream !== ws.name) return errorText(`No task ${taskId} in this workstream.`);
      const runs = store.runsForTask(taskId);
      const watches = store.watchesForTask(taskId);
      const lines: string[] = [
        `Task ${task.id}: ${task.title} [${task.status}]`,
        `Worker: ${task.workerThreadId ? `@thread:${task.workerThreadId}` : "-"} | Branch: ${task.branch ?? "-"} | Verify: ${task.verifyMode}`,
      ];
      if (task.dependsOn.length > 0) lines.push(`Dependencies (${task.dependsMode}): ${task.dependsOn.join(", ")}`);
      if (task.pr !== null) {
        lines.push(
          `PR #${task.pr.number} (${task.pr.state}, attention=${task.pr.attention}, checks=${task.pr.checks.state} ${task.pr.checks.passed}p/${task.pr.checks.failed}f/${task.pr.checks.pending}w): ${task.pr.url}`,
        );
      } else if (task.prUrl) {
        lines.push(`PR: ${task.prUrl}`);
      }
      if (task.workerThreadId !== null) {
        const [thread, execOpts, tokens, output, interactions] = await Promise.all([
          bb.sdk.threads.get({ threadId: task.workerThreadId }).catch(() => null),
          bb.sdk.threads.defaultExecutionOptions({ threadId: task.workerThreadId }).catch(() => null),
          readContextTokens(task.workerThreadId),
          bb.sdk.threads.output({ threadId: task.workerThreadId }).catch(() => ({ output: null })),
          bb.sdk.threads.interactions?.list({ threadId: task.workerThreadId }).catch(() => []) ?? Promise.resolve([]),
        ]);
        if (thread !== null || tokens !== null) {
          const modelInfo = execOpts?.model ? ` | Model: ${execOpts.model}${execOpts.reasoningLevel ? ` (${execOpts.reasoningLevel})` : ""}` : "";
          lines.push(`Thread status: ${thread?.status ?? "?"}${modelInfo}${tokens !== null ? ` | Context: ${tokens.toLocaleString()} tokens` : ""}`);
        }
        if (Array.isArray(interactions) && interactions.length > 0) {
          lines.push(`Pending interactions: ${interactions.map((i) => describeInteraction(i)).join("; ")}`);
        }
        if (output.output) lines.push(`Last output:\n${output.output.trim().slice(0, 1800)}`);
      }
      const environmentId = await environmentIdFor(task);
      if (environmentId !== null) {
        const diff = await readEnvironmentDiffFiles(environmentId);
        if (diff?.outcome === "available") {
          const files = diff.files
            .slice(0, 15)
            .map((f) => `  ${f.changeKind} ${f.path} (+${f.additions}/-${f.deletions})`)
            .join("\n");
          lines.push(`Diff: ${diff.shortstat || `${diff.files.length} files`}${files ? `\n${files}` : ""}`);
        }
      }
      if (task.handoff) lines.push(`Handoff:\n${task.handoff.slice(0, 1200)}`);
      if (watches.length > 0) {
        lines.push(
          `Watches:\n${watches
            .slice(0, 5)
            .map((w) => `  ${w.id} [${w.status}] ${w.kind} ${w.target}${w.lastState ? ` (${w.lastState})` : ""}`)
            .join("\n")}`,
        );
      }
      if (runs.length > 0) {
        lines.push(
          `Runs:\n${runs
            .slice(-6)
            .map(
              (r) =>
                `  #${r.runNumber} ${r.role}/${r.phase} [${r.status}] @thread:${r.threadId}${r.summary ? ` — ${r.summary.slice(0, 160)}` : ""}`,
            )
            .join("\n")}`,
        );
      }
      return lines.join("\n");
    },
  });

  bb.agents.registerTool({
    name: "ariadne_verify",
    description: "Run an independent hidden clean-context verifier on a task's worktree to audit the diff and run tests.",
    presentation: { label: { pending: "Starting verifier", completed: "Started verifier" } },
    parameters: z.object({
      taskId: z.string(),
      focus: z.string().max(1000).optional().describe("Specific areas or acceptance checks to verify"),
    }),
    async execute({ taskId, focus }, { threadId }) {
      const ws = await requireAriadne(threadId);
      if (typeof ws === "string") return errorText(ws);
      const task = store.task(taskId);
      if (task === undefined || task.workstream !== ws.name) return errorText(`No task ${taskId} in this workstream.`);
      const res = await startVerification(task, task.summary ?? "", focus);
      if (!res.started) return errorText(`Cannot verify ${taskId}: ${res.reason}.`);
      return `Started clean-context verifier @thread:${res.threadId} for ${taskId}.`;
    },
  });

  bb.agents.registerTool({
    name: "ariadne_watch",
    description:
      "Register a durable zero-token watch (pr-merged, pr-checks, task-done, timer, or command). Workers: call this and end your turn instead of bash polling loops.",
    presentation: { label: { pending: "Registering watch", completed: "Registered watch" } },
    parameters: z.object({
      kind: z.enum(WATCH_KINDS),
      target: z
        .string()
        .min(1)
        .max(500)
        .describe(
          "For pr-merged/pr-checks: 'self', PR URL, or 'owner/repo#123'. For task-done: taskId. For timer: duration like '30m'/'2h' or ISO timestamp. For command: shell command exiting 0 when ready.",
        ),
      resumePrompt: z.string().min(1).max(2000).describe("What to do when the watch triggers"),
      expiresInHours: z.number().min(0.1).max(168).optional().describe("Expiry timeout in hours (default 24)"),
      taskId: z.string().optional().describe("Required when called from Ariadne; inferred automatically for workers"),
    }),
    async execute({ kind, target, resumePrompt, expiresInHours, taskId: explicitTaskId }, { threadId }) {
      const asAriadne = store.workstreamByAriadne(threadId);
      let task: Task | undefined;
      let calledByWorker = false;
      if (asAriadne !== undefined && asAriadne.archived_at === null) {
        if (!explicitTaskId) return errorText("Ariadne must pass taskId to ariadne_watch.");
        task = store.task(explicitTaskId);
        if (task === undefined || task.workstream !== asAriadne.name) {
          return errorText(`No task ${explicitTaskId} in this workstream.`);
        }
      } else {
        task = store.activeTaskByWorker(threadId);
        if (task === undefined) return errorText("Only an Ariadne manager or active worker can register a watch.");
        calledByWorker = true;
      }

      if ((kind === "pr-merged" || kind === "pr-checks") && target !== "self" && parsePrTarget(target) === null) {
        return errorText(`Invalid PR target ${JSON.stringify(target)}. Use 'self', a GitHub PR URL, or 'owner/repo#number'.`);
      }
      let normalizedTarget = target.trim();
      if (kind === "timer") {
        const ts = parseTimerTarget(normalizedTarget, Date.now());
        if (ts === null) return errorText(`Invalid timer target ${JSON.stringify(target)}. Use e.g. '30m', '2h', or ISO timestamp.`);
        normalizedTarget = String(ts);
      }
      if (kind === "task-done" && store.task(normalizedTarget) === undefined) {
        return errorText(`Watched task ${normalizedTarget} not found.`);
      }

      const expiresAt = Date.now() + (expiresInHours ?? 24) * 3_600_000;
      const watch = store.insertWatch({
        workstream: task.workstream,
        taskId: task.id,
        kind: kind as WatchKind,
        target: normalizedTarget,
        resumePrompt,
        expiresAt,
      });
      if (calledByWorker) {
        store.updateTask(task.id, { status: "waiting" });
        workerTurns.reported(threadId);
      }
      store.event("watch-created", `${watch.id} ${kind} ${normalizedTarget}`, task.workstream, task.id);
      markActivity();
      publish();
      kickReconciler();
      return calledByWorker
        ? `Watch ${watch.id} registered (${kind} ${normalizedTarget}). Task ${task.id} moved to waiting. End your turn now; the orchestrator will wake you when it triggers.`
        : `Watch ${watch.id} registered on ${task.id} (${kind} ${normalizedTarget}).`;
    },
  });

  bb.agents.registerTool({
    name: "ariadne_watch_cancel",
    description: "Cancel an active watch by id.",
    presentation: { label: { pending: "Cancelling watch", completed: "Cancelled watch" } },
    parameters: z.object({ watchId: z.string() }),
    async execute({ watchId }, { threadId }) {
      const ws = await requireAriadne(threadId);
      if (typeof ws === "string") return errorText(ws);
      const watch = store.watch(watchId);
      if (watch === undefined || watch.workstream !== ws.name) return errorText(`No watch ${watchId} in this workstream.`);
      cancelWatchById(watchId);
      return `Cancelled watch ${watchId}.`;
    },
  });

  bb.agents.registerTool({
    name: "ariadne_notes_read",
    description: "Read this workstream's notes. Omit topic to list all topics with their content.",
    presentation: { label: { pending: "Reading notes", completed: "Read notes" }, suppress: true },
    parameters: z.object({ topic: z.string().optional() }),
    async execute({ topic }, { threadId }) {
      const ws = await requireAriadne(threadId);
      if (typeof ws === "string") return errorText(ws);
      const notes = store.notes(ws.name, 0).filter((n) => topic === undefined || n.topic === topic);
      if (notes.length === 0) return topic === undefined ? "No notes yet." : `No note "${topic}".`;
      return notes.map((n) => `## ${n.topic} (rev ${n.revision})\n${n.body}`).join("\n\n");
    },
  });

  bb.agents.registerTool({
    name: "ariadne_notes_write",
    description:
      "Replace a note topic with a new body. Previous versions are kept. Notes hold this workstream's live state; suggested topics: overview, status, decisions, runs. Durable knowledge goes to bb memory.",
    presentation: { label: { pending: "Updating notes", completed: "Updated notes" } },
    parameters: z.object({
      topic: z.string().min(1).max(60).regex(/^[a-z0-9-]+$/),
      body: z.string().min(1).max(20_000),
    }),
    async execute({ topic, body }, { threadId }) {
      const ws = await requireAriadne(threadId);
      if (typeof ws === "string") return errorText(ws);
      const revision = store.writeNote(ws.name, topic, body, threadId);
      publish();
      return `Saved ${topic} (rev ${revision}).`;
    },
  });

  bb.agents.registerTool({
    name: "ariadne_staging",
    description: "List recent staging integrations by Ariadne workers across all workstreams.",
    presentation: { label: { pending: "Reading staging log", completed: "Read staging log" }, suppress: true },
    parameters: z.object({ limit: z.number().int().min(1).max(100).optional() }),
    async execute({ limit }, { threadId }) {
      const ws = await requireAriadne(threadId);
      if (typeof ws === "string") return errorText(ws);
      const entries = store.staging(limit ?? 20);
      if (entries.length === 0) return "No staging integrations logged.";
      return entries
        .map((e) => `${new Date(e.at).toISOString()} ${e.service} <- ${e.branch} (${e.workstream}, @thread:${e.workerThreadId}): ${e.purpose}`)
        .join("\n");
    },
  });

  bb.agents.registerTool({
    name: "ariadne_improve",
    description:
      "Fix or improve Ariadne itself. Spawns a worker in the plugin repo that makes the change and opens a draft PR for the user to review.",
    presentation: { label: { pending: "Starting Ariadne improvement", completed: "Started Ariadne improvement" } },
    parameters: z.object({
      title: z.string().min(1).max(100).describe("Short title, e.g. 'Show harvested state on the board'"),
      problem: z.string().min(1).max(4000).describe("What is wrong or missing, from the user's point of view"),
      evidence: z.string().max(8000).optional().describe("Concrete evidence: tool errors, thread ids, quotes"),
      proposal: z.string().max(4000).optional().describe("Suggested change, if you have one"),
    }),
    async execute({ title, problem, evidence, proposal }, { threadId }) {
      const ws = await requireAriadne(threadId);
      if (typeof ws === "string") return errorText(ws);
      if (config.pluginProjectId === "") return errorText("ariadne_improve is not configured (pluginProjectId).");
      const remote = parseGitHubRemote((await projectSource(config.pluginProjectId)).remoteUrl);
      if (remote === null) return errorText("The plugin repo project has no GitHub remote.");
      const { task, queued, note } = await spawnOrQueueWorker(threadId, {
        title: `Improve Ariadne: ${title}`,
        prompt: improvementKickoff({ problem, evidence, proposal, requestedBy: threadId, repo: `${remote.owner}/${remote.repo}` }),
        projectId: config.pluginProjectId,
      });
      store.event("improvement-started", title, ws.name, task.id);
      return queued
        ? `Queued improvement task ${task.id} (${title}); ${note}.`
        : `Started improvement worker @thread:${task.workerThreadId} (task ${task.id}); ${note}. It will report a draft PR.`;
    },
  });

  bb.agents.registerTool({
    name: "ariadne_report",
    description: "Report to Ariadne: pr-opened, blocked, done or fyi.",
    presentation: { label: { pending: "Reporting to Ariadne", completed: "Reported to Ariadne" } },
    parameters: z.object({
      status: z.enum(["pr-opened", "blocked", "done", "fyi"]),
      note: z.string().min(1).max(4000),
      prUrl: z.string().optional(),
      handoff: z.string().max(4000).optional().describe("Concise structured state for future fresh-context runs"),
      urgent: z.boolean().optional().describe("For fyi only: wake Ariadne immediately instead of logging quietly"),
    }),
    async execute({ status, note, prUrl, handoff, urgent }, { threadId }) {
      const task = store.activeTaskByWorker(threadId);
      const ws = task === undefined ? undefined : store.workstream(task.workstream);
      if (task === undefined || ws === undefined || ws.archived_at !== null) {
        return errorText("This thread is not an active Ariadne worker.");
      }

      const nextPrUrl = prUrl ?? task.prUrl;
      const isNewPr = prUrl !== undefined && prUrl !== task.prUrl;
      await refreshBranch(task);

      if (status === "fyi") {
        store.updateTask(task.id, {
          ...(prUrl ? { prUrl } : {}),
          ...(handoff ? { handoff } : {}),
        });
        store.event("report-fyi", note, task.workstream, task.id);
        markActivity();
        publish();
        if (urgent) {
          await tellAriadne(
            ws.ariadne_thread_id,
            `${PLUGIN_PREFIX} Worker @thread:${threadId} (${task.id}) urgent fyi: ${note}`,
            threadId,
          );
        }
        return urgent ? "Urgent FYI sent to Ariadne." : "Logged FYI on the board (Ariadne not interrupted).";
      }

      if (status === "done") {
        const latest = store.updateTask(task.id, {
          prUrl: nextPrUrl ?? undefined,
          summary: note.slice(0, 2000),
          ...(handoff ? { handoff } : {}),
        })!;
        store.event("report-done", note, task.workstream, task.id);
        workerTurns.reported(threadId);
        markActivity();

        const envId = await environmentIdFor(latest);
        const hasDiff = envId !== null ? await taskHasDiffOrPr(latest, prUrl) : false;
        if (
          shouldRunVerifier({
            verifyMode: latest.verifyMode,
            verifyByDefault: config.verifyByDefault,
            hasEnvironment: envId !== null,
            hasPrOrDiff: hasDiff,
          })
        ) {
          const started = await startVerification(latest, note);
          if (started.started) {
            return `Submitted for clean-context verification (@thread:${started.threadId}). End your turn now; the orchestrator will notify Ariadne on pass or route fixes back to you.`;
          }
        }

        const hasOpenPr = nextPrUrl !== null && latest.pr?.state !== "merged";
        const nextStatus = hasOpenPr ? "in-review" : "done";
        store.updateTask(task.id, { status: nextStatus });
        store.updateRunByThread(threadId, { status: "completed", summary: note.slice(0, 2000), endedAt: Date.now() });
        publish();
        kickReconciler();
        // Do NOT send a duplicate tellAriadne here: BB's single child-completed notice
        // delivers the worker's final output ~2s later.
        return `Recorded done (${nextStatus}) on the board.`;
      }

      if (status === "pr-opened") {
        store.updateTask(task.id, {
          status: "in-review",
          prUrl: nextPrUrl ?? undefined,
          ...(handoff ? { handoff } : {}),
        });
        store.event("report-pr-opened", note, task.workstream, task.id);
        workerTurns.reported(threadId);
        markActivity();
        publish();
        kickReconciler();
        if (isNewPr) {
          await tellAriadne(
            ws.ariadne_thread_id,
            `${PLUGIN_PREFIX} Worker @thread:${threadId} (${task.id}) opened PR ${prUrl}: ${note}`,
            threadId,
          );
        }
        return "Recorded PR on the board.";
      }

      // blocked
      store.updateTask(task.id, {
        status: "blocked",
        ...(prUrl ? { prUrl } : {}),
        ...(handoff ? { handoff } : {}),
      });
      store.event("report-blocked", note, task.workstream, task.id);
      workerTurns.reported(threadId);
      markActivity();
      publish();
      await tellAriadne(
        ws.ariadne_thread_id,
        `${PLUGIN_PREFIX} Worker @thread:${threadId} (${task.id}) reports blocked${prUrl ? ` ${prUrl}` : ""}: ${note}`,
        threadId,
      );
      return "Reported blocker to Ariadne.";
    },
  });

  bb.agents.registerTool({
    name: "ariadne_verify_verdict",
    description: "Submit the clean-context verification verdict (pass or fail) for this task.",
    presentation: { label: { pending: "Submitting verification verdict", completed: "Submitted verification verdict" } },
    parameters: z.object({
      verdict: z.enum(["pass", "fail"]),
      summary: z.string().min(1).max(2000),
      issues: z.array(z.string().max(600)).max(20).optional().describe("Concrete file/line defects when verdict is fail"),
      checksRun: z.string().max(1000).optional().describe("Tests, typechecks, or commands executed"),
    }),
    async execute({ verdict, summary, issues, checksRun }, { threadId }) {
      const run = store.runByThread(threadId);
      if (run === undefined || run.role !== "verifier") {
        return errorText("Only an Ariadne verifier thread can submit a verification verdict.");
      }
      // Defer archive until thread.idle so we never abort this tool call mid-turn.
      const res = await settleVerification(
        threadId,
        { passed: verdict === "pass", summary, issues, checksRun },
        { cleanupNow: false },
      );
      return `${res} End your turn now.`;
    },
  });

  bb.agents.registerTool({
    name: "ariadne_staging_log",
    description: "Record that you integrated a branch into staging. Call right after chat-integrate or similar.",
    presentation: { label: { pending: "Logging staging integration", completed: "Logged staging integration" } },
    parameters: z.object({
      service: z.string().min(1).max(80),
      branch: z.string().min(1).max(200),
      purpose: z.string().min(1).max(500),
    }),
    async execute({ service, branch, purpose }, { threadId }) {
      const task = store.activeTaskByWorker(threadId);
      if (task === undefined) return errorText("This thread is not an active Ariadne worker.");
      store.logStaging({ workstream: task.workstream, workerThreadId: threadId, taskId: task.id, service, branch, purpose });
      store.updateTask(task.id, { branch });
      store.event("staging", `${service} ${branch}`, task.workstream, task.id);
      markActivity();
      publish();
      return "Logged.";
    },
  });

  // ------------------------------------------------------- composer mentions

  if (typeof bb.ui?.registerMentionProvider === "function") {
    bb.ui.registerMentionProvider({
      id: "ariadne-tasks",
      label: "Ariadne tasks",
      triggers: ["#"],
      search({ query, threadId }) {
        const ws =
          threadId === null
            ? undefined
            : store.workstreamByAriadne(threadId) ??
              (() => {
                const task = store.activeTaskByWorker(threadId);
                return task ? store.workstream(task.workstream) : undefined;
              })();
        const pool =
          ws !== undefined
            ? store.tasks(ws.name)
            : store.allTasks().filter((t) => store.workstream(t.workstream)?.archived_at === null);
        const needle = query.trim().toLowerCase();
        return pool
          .filter((t) => {
            if (needle === "") return true;
            const wsRow = store.workstream(t.workstream);
            const wsLabel = wsRow ? store.workstreamTitle(wsRow) : t.workstream;
            return (
              t.id.toLowerCase().includes(needle) ||
              t.title.toLowerCase().includes(needle) ||
              t.workstream.toLowerCase().includes(needle) ||
              wsLabel.toLowerCase().includes(needle)
            );
          })
          .slice(0, 15)
          .map((t) => {
            const wsRow = store.workstream(t.workstream);
            const wsLabel = wsRow ? store.workstreamTitle(wsRow) : t.workstream;
            return {
              id: t.id,
              title: `${t.id}: ${t.title}`,
              subtitle: [
                ws === undefined ? wsLabel : null,
                t.status,
                t.pr ? `#${t.pr.number} ${t.pr.checks.state}` : null,
              ]
                .filter(Boolean)
                .join(" · "),
            };
          });
      },
      resolve(taskId) {
        const task = store.task(taskId);
        if (task === undefined) throw new Error(`Ariadne task ${taskId} not found.`);
        const watches = store.watchesForTask(task.id, true);
        const runs = store.runsForTask(task.id);
        const lines = [
          `Ariadne task ${task.id} (${task.workstream}): ${task.title}`,
          `Status: ${task.status} | Worker: ${task.workerThreadId ? `@thread:${task.workerThreadId}` : "none"} | Branch: ${task.branch ?? "-"}`,
        ];
        if (task.pr !== null) {
          lines.push(`PR #${task.pr.number} (${task.pr.state}, checks=${task.pr.checks.state}): ${task.pr.url}`);
        } else if (task.prUrl) {
          lines.push(`PR: ${task.prUrl}`);
        }
        if (task.dependsOn.length > 0) lines.push(`Depends on (${task.dependsMode}): ${task.dependsOn.join(", ")}`);
        if (watches.length > 0) {
          lines.push(`Active watches: ${watches.map((w) => `${w.kind} ${w.target}`).join(", ")}`);
        }
        if (task.summary) lines.push(`Summary: ${task.summary}`);
        if (task.handoff) lines.push(`Handoff: ${task.handoff.slice(0, 800)}`);
        if (runs.length > 0) lines.push(`Runs: ${runs.length}`);
        return { context: lines.join("\n") };
      },
    });
  }

  // ----------------------------------------------------------------- events

  bb.experimental_hooks.on("message.dispatch", (ctx) => {
    try {
      const task = store.activeTaskByWorker(ctx.thread.id);
      if (task === undefined) return { action: "proceed" };
      if (ctx.attempt === "start-turn" && ctx.thread.status !== "active") {
        const byUser =
          ctx.initiator === "user" && ctx.senderThreadId === null && ctx.origin === null && ctx.thread.status !== "pending";
        if (byUser) {
          workerTurns.started(ctx.thread.id, "user");
        } else if (ctx.senderThreadId === store.workstream(task.workstream)?.ariadne_thread_id) {
          workerTurns.started(ctx.thread.id, "ariadne");
        }
      } else if (ctx.attempt === "join-turn" && ctx.senderThreadId === store.workstream(task.workstream)?.ariadne_thread_id) {
        workerTurns.steered(ctx.thread.id, "ariadne");
      }
    } catch (error) {
      bb.log.warn(`message.dispatch hook: ${String(error)}`);
    }
    return { action: "proceed" };
  });

  bb.events.on("interaction.pending", async ({ thread, interaction }) => {
    const task = store.activeTaskByWorker(thread.id);
    if (task === undefined) return;
    const ws = store.workstream(task.workstream);
    if (ws === undefined || ws.archived_at !== null) return;
    markActivity();
    await tellAriadne(
      ws.ariadne_thread_id,
      `${PLUGIN_PREFIX} Worker @thread:${thread.id} (${task.id}) is waiting on ${describeInteraction(interaction)}. It is stalled until someone answers in that thread.`,
      thread.id,
    );
  });

  async function onThreadRetired({ thread }: { thread: { id: string; originPluginId: string | null } }) {
    pendingSessionActions.delete(thread.id);
    const ws = store.workstreamByAriadne(thread.id);
    if (ws !== undefined) {
      store.archiveWorkstream(ws.name);
      store.cancelWatchesForWorkstream(ws.name);
      publish();
      return;
    }
    const run = store.runByThread(thread.id);
    // Ignore superseded worker rotations and hidden verifiers!
    if (run !== undefined && (run.status === "superseded" || run.role === "verifier")) return;

    const task = store.activeTaskByWorker(thread.id);
    if (task === undefined || deleting.has(task.workstream)) return;
    if (task.status === "running" || task.status === "blocked" || task.status === "waiting" || task.status === "verifying") {
      store.updateTask(task.id, { status: "dropped" });
      store.cancelWatchesForTask(task.id);
    }
    publish();
    kickReconciler();
    try {
      await retireWorkerEnvironment(task);
    } catch (error) {
      bb.log.warn(`retire worktree ${task.id} failed: ${String(error)}`);
    }
  }
  bb.events.on("thread.archived", onThreadRetired);
  bb.events.on("thread.deleted", onThreadRetired);

  bb.events.on("thread.unarchived", ({ thread }) => {
    const ws = store.workstreamByAriadne(thread.id);
    if (ws === undefined || ws.archived_at === null) return;
    store.unarchiveWorkstream(ws.name);
    publish();
  });

  bb.events.on("thread.active", ({ thread }) => {
    if (!isManagedThread(thread.id)) return;
    markActivity();
    const task = store.activeTaskByWorker(thread.id);
    if (task !== undefined) workerTurns.active(thread.id);
  });

  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    if (!isManagedThread(thread.id)) return;
    markActivity();

    // Deferred session action (adopt/detach runtime reload, self-compact, clear-context).
    const pendingAction = pendingSessionActions.get(thread.id);
    if (pendingAction !== undefined) {
      pendingSessionActions.delete(thread.id);
      await executePendingSessionAction(thread.id, pendingAction);
      return;
    }

    // Hidden verifier turn finished: settle as failed if it never called ariadne_verify_verdict,
    // or archive cleanly now that the verdict tool call has completed.
    const run = store.runByThread(thread.id);
    if (run !== undefined && run.role === "verifier") {
      if (run.status === "running") {
        const summary =
          lastAssistantText?.trim().slice(0, 600) ||
          "Verifier finished its turn without calling ariadne_verify_verdict.";
        await settleVerification(thread.id, { passed: false, summary }, { cleanupNow: true });
      } else {
        await bb.sdk.threads.archive({ threadId: thread.id }).catch((err: unknown) => {
          if (!isNotFound(err)) bb.log.warn(`archive verifier ${thread.id}: ${String(err)}`);
        });
      }
      return;
    }

    // Manager thread went idle -> check if auto-compaction is due.
    const asAriadne = store.workstreamByAriadne(thread.id);
    if (asAriadne !== undefined && asAriadne.archived_at === null) {
      kickReconciler();
      return;
    }

    const task = store.activeTaskByWorker(thread.id);
    if (task === undefined) return;

    const tokens = await readContextTokens(thread.id);
    if (tokens !== null) {
      store.updateTask(task.id, { contextTokens: tokens });
      store.updateRunByThread(thread.id, { contextTokens: tokens });
    }

    const by = workerTurns.finished(thread.id);
    const ws = store.workstream(task.workstream);
    if (by !== null && ws !== undefined && ws.archived_at === null) {
      store.event(`turn-by-${by}`, thread.id, ws.name, task.id);
      const what =
        by === "user"
          ? "the user started by talking to it directly. BB's completion notice for it is FYI for your notes. Don't relay it and don't ask the user about it; they are discussing it there"
          : "its own background task started. Treat completion notices from such turns as progress: act only on a failure, a blocker or a finished result, and say nothing to the user otherwise";
      await tellAriadne(
        ws.ariadne_thread_id,
        `${PLUGIN_PREFIX} Worker @thread:${thread.id} (${task.id}) finished a turn ${what}. Later turns like this are not flagged again until you steer it or it reports.`,
        thread.id,
      );
    }
    kickReconciler();
  });

  bb.events.on("thread.failed", async ({ thread, error }) => {
    if (!isManagedThread(thread.id)) return;
    markActivity();

    const run = store.runByThread(thread.id);
    if (run !== undefined && run.role === "verifier") {
      await settleVerification(thread.id, {
        passed: false,
        summary: `Verifier thread failed: ${error ?? "unknown error"}`,
      });
      return;
    }

    const task = store.activeTaskByWorker(thread.id);
    const ws = task === undefined ? undefined : store.workstream(task.workstream);
    if (task === undefined || ws === undefined || ws.archived_at !== null) return;
    store.event("worker-failed", error ?? "unknown error", ws.name, task.id);
    // Defer transient rate-limit retries to BB's built-in provider-retry plugin;
    // still surface terminal thread failures clearly to Ariadne.
    await tellAriadne(
      ws.ariadne_thread_id,
      `${PLUGIN_PREFIX} Worker @thread:${thread.id} (${task.id}, ${task.title}) failed: ${error ?? "unknown error"}. Use ariadne_steer (or rotate=true) to resume.`,
      thread.id,
    );
  });

  // -------------------------------------------------------------------- RPC

  bb.rpc.register(rpcContract, {
    overview: async () => ({
      workstreams: await Promise.all(store.workstreams().map(workstreamView)),
    }),
    projects: async () => {
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      return {
        projects: projects.map((p) => {
          const source = p.sources.find((s) => s.isDefault) ?? p.sources[0];
          return { id: p.id, name: p.name, kind: p.kind, hostId: source?.hostId ?? null };
        }),
      };
    },
    agent_defaults_get: async () => getAgentDefaults(),
    agent_defaults_set: async (next) => setAgentDefaults(next),
    workstream_create: async ({ name, projectId, links, ariadne, worker }) => ({
      ariadneThreadId: await createWorkstream(name, projectId, links, { ariadne, worker }),
    }),
    workstream_archive: async ({ name }) => {
      const ws = store.workstream(name);
      if (ws === undefined) throw new Error(`No workstream ${name}.`);
      await bb.sdk.threads.archive({ threadId: ws.ariadne_thread_id });
      store.archiveWorkstream(name);
      store.cancelWatchesForWorkstream(name);
      publish();
      return { ok: true };
    },
    workstream_delete_preview: async ({ name }) => deletionPreview(name),
    workstream_delete: async ({ name }) => ({ ok: true, detail: await deleteWorkstream(name) }),
    workstream_compact: async ({ name }) => {
      const ws = store.workstream(name);
      if (ws === undefined) throw new Error(`No workstream ${name}.`);
      await bb.sdk.threads.compact({ threadId: ws.ariadne_thread_id });
      store.event("manager-compacted", `${ws.ariadne_thread_id} (manual)`, name);
      return { ok: true, detail: `Requested compaction for ${name}.` };
    },
    board: async ({ workstream }) => ({ tasks: boardTasks(workstream) }),
    task_drop_preview: async ({ taskId }) => {
      const task = store.task(taskId);
      return { risk: task === undefined ? null : await workAtRisk(task) };
    },
    task_drop: async ({ taskId }) => ({ ok: true, detail: await dropTask(taskId) }),
    task_dispatch_now: async ({ taskId }) => {
      const task = store.task(taskId);
      if (task === undefined) throw new Error(`No task ${taskId}.`);
      if (task.status !== "queued") throw new Error(`Task ${taskId} is ${task.status}, not queued.`);
      const { note } = await launchTaskWorker(task);
      return { ok: true, detail: `Dispatched ${task.title}; ${note}.` };
    },
    task_rotate: async ({ taskId, reason }) => {
      const task = store.task(taskId);
      if (task === undefined) throw new Error(`No task ${taskId}.`);
      const instruction = reason?.trim() || "Continue from the current worktree state and latest handoff.";
      const res = await rotateTaskWorker(task, instruction, "rotate", "orchestrator");
      return { ok: true, detail: `Rotated ${task.title} to run #${res.runNumber} (${res.threadId}).` };
    },
    task_verify: async ({ taskId, focus }) => {
      const task = store.task(taskId);
      if (task === undefined) throw new Error(`No task ${taskId}.`);
      const res = await startVerification(task, task.summary ?? "", focus);
      if (!res.started) throw new Error(`Cannot verify ${taskId}: ${res.reason}.`);
      return { ok: true, detail: `Started verifier (${res.threadId}) for ${task.title}.` };
    },
    watch_cancel: async ({ watchId }) => {
      const watch = cancelWatchById(watchId);
      if (watch === null) throw new Error(`No watch ${watchId}.`);
      return { ok: true, detail: `Cancelled watch ${watchId}.` };
    },
    notes: async ({ workstream }) => ({ notes: store.notes(workstream) }),
    staging: async ({ limit }) => ({ entries: store.staging(limit) }),
    thread_context: async ({ threadId }) => {
      const ws = store.workstreamByAriadne(threadId);
      if (ws !== undefined && ws.archived_at === null) return { role: "ariadne" as const, workstream: ws.name, taskId: null };
      const activeTask = store.activeTaskByWorker(threadId);
      if (activeTask !== undefined) return { role: "worker" as const, workstream: activeTask.workstream, taskId: activeTask.id };
      const run = store.runByThread(threadId);
      if (run !== undefined && run.role === "verifier") return { role: "verifier" as const, workstream: run.workstream, taskId: run.taskId };
      return { role: "none" as const, workstream: null, taskId: null };
    },
  });

  // -------------------------------------------------------------------- CLI

  bb.cli.register(
    defineCli({
      name: "ariadne",
      summary: "Ariadne orchestrator: workstreams, boards, watches, runs, notes and the staging log",
      commands: {
        create: cliCommand({
          summary: "Create a workstream and its Ariadne thread",
          positionals: [{ name: "workstream", description: "Workstream name", required: true }],
          options: {
            project: { type: "string", description: "Project id (defaults to the invoking thread's project)" },
            link: { type: "string", repeatable: true, description: "Link to attach (repeatable)" },
            provider: { type: "string", description: "Provider id for the Ariadne thread" },
            model: { type: "string", description: "Model id for the Ariadne thread" },
            "reasoning-level": {
              type: "string",
              description: `Reasoning level for the Ariadne thread (${REASONING_LEVELS.join(", ")})`,
            },
            "service-tier": { type: "string", description: "Service tier for the Ariadne thread" },
            "worker-provider": { type: "string", description: "Default provider id for workers in this workstream" },
            "worker-model": { type: "string", description: "Default model id for workers in this workstream" },
            "worker-reasoning-level": {
              type: "string",
              description: `Default reasoning level for workers in this workstream (${REASONING_LEVELS.join(", ")})`,
            },
            "worker-service-tier": { type: "string", description: "Default service tier for workers in this workstream" },
          },
          async run(input, ctx) {
            const projectId = input.options.project ?? ctx.projectId;
            if (projectId === undefined) {
              throw new PluginCliError("no project", { code: "missing_project", hint: "Pass --project <id> (bb project list)." });
            }
            const parseReasoning = (raw: string | undefined, flag: string): ReasoningLevel | null => {
              if (raw === undefined || raw.trim() === "") return null;
              const trimmed = raw.trim();
              if (!isReasoningLevel(trimmed)) {
                throw new PluginCliError(`invalid ${flag}: ${trimmed}`, {
                  code: "invalid_reasoning_level",
                  hint: `Valid values: ${REASONING_LEVELS.join(", ")}`,
                });
              }
              return trimmed;
            };
            const ariadne: ExecutionConfig = {
              providerId: input.options.provider ?? null,
              model: input.options.model ?? null,
              reasoningLevel: parseReasoning(input.options["reasoning-level"], "--reasoning-level"),
              serviceTier: input.options["service-tier"] ?? null,
            };
            const worker: ExecutionConfig = {
              providerId: input.options["worker-provider"] ?? null,
              model: input.options["worker-model"] ?? null,
              reasoningLevel: parseReasoning(input.options["worker-reasoning-level"], "--worker-reasoning-level"),
              serviceTier: input.options["worker-service-tier"] ?? null,
            };
            const id = await createWorkstream(
              input.positionals.workstream,
              projectId,
              [input.options.link ?? []].flat(),
              { ariadne, worker },
            );
            return { exitCode: 0, stdout: `Created Ariadne ${id} for "${input.positionals.workstream}".` };
          },
        }),
        adopt: cliCommand({
          summary: "Turn the current (or specified) normal BB thread into an Ariadne manager thread",
          positionals: [{ name: "workstream", description: "Optional workstream name (defaults to thread title slug)", required: false }],
          options: {
            thread: { type: "string", description: "Thread id to adopt (defaults to the invoking thread)" },
            link: { type: "string", repeatable: true, description: "Link to attach (repeatable)" },
            continue: { type: "string", description: "Immediate orchestration instruction to run once tools reload" },
            "no-pin": { type: "boolean", description: "Do not pin the thread" },
          },
          async run(input, ctx) {
            const targetThreadId = input.options.thread ?? ctx.threadId;
            if (targetThreadId === undefined) {
              throw new PluginCliError("no thread", { code: "missing_thread", hint: "Run inside a BB thread or pass --thread <id>." });
            }
            const res = await adoptThreadAsWorkstream(targetThreadId, {
              name: input.positionals.workstream || undefined,
              links: [input.options.link ?? []].flat(),
              pin: !input.options["no-pin"],
              continuePrompt: input.options.continue,
            });
            const childNote = res.adoptedChildren > 0 ? ` Adopted ${res.adoptedChildren} existing child thread(s) as workers.` : "";
            const reloadNote =
              res.reloadMode === "deferred"
                ? " End your turn now; Ariadne will reload this session cleanly once idle so all ariadne_* tools activate."
                : " Session runtime reloaded; all ariadne_* tools are ready for the next turn.";
            return {
              exitCode: 0,
              stdout: `Adopted ${targetThreadId} as Ariadne workstream "${res.name}".${childNote}${reloadNote}`,
            };
          },
        }),
        detach: cliCommand({
          summary: "Turn an Ariadne manager thread back into a normal BB thread",
          positionals: [{ name: "workstream", description: "Workstream name (optional inside an Ariadne thread)", required: false }],
          options: {
            thread: { type: "string", description: "Ariadne thread id (defaults to invoking thread)" },
          },
          async run(input, ctx) {
            let name = input.positionals.workstream;
            if (!name) {
              const tid = input.options.thread ?? ctx.threadId;
              const ws = tid ? store.workstreamByAriadne(tid) : undefined;
              if (ws === undefined) {
                throw new PluginCliError("no workstream", {
                  code: "missing_workstream",
                  hint: "Pass a workstream name or run inside an Ariadne thread.",
                });
              }
              name = ws.name;
            }
            return { exitCode: 0, stdout: await detachWorkstream(name) };
          },
        }),
        "adopt-worker": cliCommand({
          summary: "Adopt an existing normal BB thread as a tracked worker subthread under a workstream",
          positionals: [
            { name: "workstream", description: "Workstream name", required: true },
            { name: "threadId", description: "Existing thread id to adopt", required: true },
          ],
          options: {
            title: { type: "string", description: "Optional task title override" },
          },
          async run(input) {
            const { task, alreadyTracked } = await adoptWorkerThread(
              input.positionals.workstream,
              input.positionals.threadId,
              { title: input.options.title, reparent: true, notifyAriadne: true },
            );
            return {
              exitCode: 0,
              stdout: alreadyTracked
                ? `Already tracked as ${task.id} (${task.title}).`
                : `Adopted ${input.positionals.threadId} as task ${task.id} (${task.title}).`,
            };
          },
        }),
        "detach-worker": cliCommand({
          summary: "Detach a tracked worker subthread back into a normal standalone BB thread",
          positionals: [{ name: "taskId", description: "Task id", required: true }],
          async run(input) {
            return { exitCode: 0, stdout: await detachWorkerTask(input.positionals.taskId, { reparentToNull: true, notifyAriadne: true }) };
          },
        }),
        list: cliCommand({
          summary: "List workstreams",
          async run() {
            const rows = await Promise.all(store.workstreams().map(workstreamView));
            const lines = rows.map(
              (w) =>
                `${w.title}${w.title !== w.name ? ` (${w.name})` : ""}${w.archived ? " (archived)" : ""}  ariadne=${w.ariadneThreadId}  project=${w.projectName ?? w.projectId}  queued=${w.counts.queued} running=${w.counts.running} verifying=${w.counts.verifying} waiting=${w.counts.waiting} blocked=${w.counts.blocked} in-review=${w.counts.inReview} done=${w.counts.done}`,
            );
            return { exitCode: 0, stdout: lines.length === 0 ? "No workstreams." : lines.join("\n") };
          },
        }),
        delete: cliCommand({
          summary: "Delete a workstream: archive its workers, delete its Ariadne thread and drop its board and notes",
          positionals: [{ name: "workstream", description: "Workstream name", required: true }],
          options: { yes: { type: "boolean", description: "Delete without previewing first" } },
          async run(input) {
            const name = input.positionals.workstream;
            if (!input.options.yes) {
              if (store.workstream(name) === undefined) return { exitCode: 0, stdout: `No workstream ${name}; nothing to delete.` };
              const preview = await deletionPreview(name);
              const lines = [
                `Deleting ${name} archives ${preview.liveWorkers} live workers, deletes its Ariadne thread, and removes ${preview.tasks} tasks and ${preview.notes} notes. The staging log is kept.`,
                ...preview.risks.map((r) => `Work at risk in ${r.taskId} (${r.title}): ${r.risk}`),
              ];
              throw new PluginCliError(lines.join("\n"), { code: "confirm_delete", hint: `Re-run with --yes: bb ariadne delete ${name} --yes` });
            }
            return { exitCode: 0, stdout: await deleteWorkstream(name) };
          },
        }),
        board: cliCommand({
          summary: "Show a workstream's tasks",
          positionals: [{ name: "workstream", description: "Workstream name", required: true }],
          async run(input) {
            const tasks = store.tasks(input.positionals.workstream);
            const lines = tasks.map((t) =>
              boardRow(t, false, {
                watches: store.watchesForTask(t.id, true),
                runs: store.runsForTask(t.id),
              }),
            );
            return { exitCode: 0, stdout: lines.length === 0 ? "No tasks." : lines.join("\n") };
          },
        }),
        watches: cliCommand({
          summary: "List active durable watches",
          positionals: [{ name: "workstream", description: "Optional workstream name", required: false }],
          async run(input) {
            const watches: Watch[] = store.activeWatches(input.positionals.workstream || undefined);
            const lines = watches.map(
              (w) => `${w.id}  ${w.workstream}/${w.taskId}  ${w.kind}  ${w.target}  state=${w.lastState ?? "pending"}`,
            );
            return { exitCode: 0, stdout: lines.length === 0 ? "No active watches." : lines.join("\n") };
          },
        }),
        runs: cliCommand({
          summary: "Show run history (workers and verifiers) for a task",
          positionals: [{ name: "taskId", description: "Task id", required: true }],
          async run(input) {
            const runs = store.runsForTask(input.positionals.taskId);
            const lines = runs.map(
              (r) =>
                `#${r.runNumber}  ${r.role}/${r.phase}  [${r.status}]  ${r.threadId}${r.contextTokens ? `  ${Math.round(r.contextTokens / 1000)}k tok` : ""}${r.summary ? `  ${r.summary.slice(0, 140)}` : ""}`,
            );
            return { exitCode: 0, stdout: lines.length === 0 ? "No runs recorded." : lines.join("\n") };
          },
        }),
        reconcile: cliCommand({
          summary: "Run one immediate control-plane reconciliation pass",
          async run() {
            await reconcileOnce();
            return { exitCode: 0, stdout: "Reconciled." };
          },
        }),
        notes: cliCommand({
          summary: "Show a workstream's notes",
          positionals: [{ name: "workstream", description: "Workstream name", required: true }],
          async run(input) {
            const notes = store.notes(input.positionals.workstream, 0);
            const out = notes.map((n) => `## ${n.topic} (rev ${n.revision})\n${n.body}`).join("\n\n");
            return { exitCode: 0, stdout: out === "" ? "No notes." : out };
          },
        }),
        staging: cliCommand({
          summary: "Show recent staging integrations",
          options: { limit: { type: "integer", min: 1, max: 200, description: "Rows to show (1-200)", default: 20 } },
          async run(input) {
            const entries = store.staging(Number(input.options.limit ?? 20));
            const lines = entries.map(
              (e) => `${new Date(e.at).toISOString()}  ${e.service}  ${e.branch}  ${e.workstream}  ${e.purpose}`,
            );
            return { exitCode: 0, stdout: lines.length === 0 ? "No entries." : lines.join("\n") };
          },
        }),
      },
    }),
  );
}
