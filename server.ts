// bb-plugin-ariadne — backend entry.
//
// Ariadne is a manager thread per workstream. It spawns worker threads into
// BB-managed worktrees, tracks them on a board, keeps machine-maintained notes
// and a staging log, and hears about workers through BB's native
// child-completed notification plus this plugin's targeted alerts.
// Design and the findings behind it: docs/v0-spec.md.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { PluginCliError, cliCommand, defineCli } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { boardRow } from "./src/board";
import { CHANGED_CHANNEL, TASK_STATUSES, rpcContract, type PrSummary, type Task, type Workstream } from "./src/contract";
import { openStore, type WorkstreamRow } from "./src/db";
import {
  branchExists,
  branchIsSafeToDelete,
  currentBranch,
  defaultBranch,
  deleteBranch,
  parseGitHubRemote,
  refreshBase,
  worktreeDirt,
} from "./src/git";
import { ariadneInstructions, lessonsInstructions, workerInstructions } from "./src/instructions";

interface AriadneMetadata {
  role?: "ariadne" | "worker";
  workstream?: string;
  ariadneThreadId?: string;
  taskId?: string;
}

const HEARTBEAT_CRON = "*/10 * * * *";
// BB's sidebar has no per-thread custom icons (row indicators are a fixed
// set), so titles carry the mark: a ball of yarn for Ariadne, a thread for
// each worker.
const ARIADNE_MARK = "🧶";
const WORKER_MARK = "🧵";
const PLUGIN_PREFIX = "[ariadne plugin]";

function text(value: string) {
  return [{ type: "text" as const, text: value, mentions: [] }];
}

function errorText(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
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
- server.ts (backend: tools, events, heartbeat, RPC, CLI), src/ (db, git, instructions, contract), app.tsx (UI).
- docs/v0-spec.md is the design; update it when behaviour changes. The README records findings.
- Plugin authoring docs: the bb-plugin-authoring skill.

## Definition of done
A draft PR in ${input.repo} with the change, a "## Motivation" section, and open questions listed.

## Rules
- Run npm ci if node_modules is missing. Before committing: npx tsc -p . must pass, and bb plugin build must succeed.
- Keep the change small and focused on the problem. Match the surrounding code style.
- Never reload, reinstall or edit the live plugin checkout; the user applies merged changes.
- Commit on your branch, then push with: env -u GH_TOKEN -u GITHUB_TOKEN git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push -u origin HEAD
- Open the PR with: env -u GH_TOKEN -u GITHUB_TOKEN gh pr create --draft -R ${input.repo}
- Report the PR with ariadne_report (status pr-opened, prUrl), then finish with ariadne_report done.`;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    workerProvider: {
      type: "string",
      label: "Worker provider",
      description: "Provider id for worker threads (bb provider list).",
      default: "claude-code",
    },
    workerModel: {
      type: "string",
      label: "Worker model",
      description: "Model for worker threads. Empty uses the provider default.",
      default: "",
    },
    ariadneProvider: {
      type: "string",
      label: "Ariadne provider",
      default: "claude-code",
    },
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
    stuckMinutes: {
      type: "number",
      label: "Minutes before an idle running worker counts as stuck",
      default: 30,
    },
    dormantMinutes: {
      type: "number",
      label: "Minutes without changes before the heartbeat goes quiet",
      default: 60,
    },
  });
  const config = await settings.get();
  const store = openStore(bb);

  // Resolved once so configure() (synchronous) can name the checkout to apply updates in.
  let pluginCheckout: string | null = null;
  if (config.pluginProjectId !== "") {
    void bb.sdk.projects
      .get({ projectId: config.pluginProjectId })
      .then((project) => {
        pluginCheckout = (project.sources.find((s) => s.isDefault) ?? project.sources[0])?.path ?? null;
      })
      .catch((error: unknown) => bb.log.warn(`plugin project ${config.pluginProjectId}: ${String(error)}`));
  }

  let lastActivityAt = Date.now();
  const markActivity = () => {
    lastActivityAt = Date.now();
  };
  const publish = () => bb.realtime.publish(CHANGED_CHANNEL, { at: Date.now() });

  async function metadataOf(threadId: string): Promise<AriadneMetadata> {
    return (await bb.sdk.threads.getPluginMetadata({ threadId })) as AriadneMetadata;
  }

  async function tellAriadne(ariadneThreadId: string, message: string, senderThreadId?: string) {
    try {
      await bb.sdk.threads.send({ threadId: ariadneThreadId, mode: "auto", input: text(message), senderThreadId });
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
      remoteUrl: project.gitRemoteUrl,
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

  // ---------------------------------------------------------------- actions

  async function createWorkstream(name: string, projectId: string, links: string[]): Promise<string> {
    if (store.workstream(name) !== undefined) throw new Error(`Workstream "${name}" already exists.`);
    const source = await projectSource(projectId);
    // Ariadne reads code in the shared checkout for kickoffs; its instructions
    // forbid editing there. Personal projects get a personal workspace.
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
      providerId: config.ariadneProvider || undefined,
      permissionMode: "full",
      pluginMetadata: { role: "ariadne", workstream: name },
    });
    store.insertWorkstream(name, thread.id, projectId, links);
    store.event("workstream-created", thread.id, name);
    publish();
    return thread.id;
  }

  async function spawnWorker(
    ariadneThreadId: string,
    args: { title: string; prompt: string; links?: string[]; model?: string; baseBranch?: string; projectId?: string },
  ): Promise<{ task: Task; note: string }> {
    const ws = store.workstreamByAriadne(ariadneThreadId);
    if (ws === undefined) throw new Error("This Ariadne thread has no workstream record.");
    const projectId = args.projectId ?? ws.project_id;
    const source = await projectSource(projectId);
    let environment;
    let note = "";
    if (source.kind === "standard" && source.path !== null) {
      const branch = args.baseBranch ?? (await defaultBranch(source.path));
      const base = await refreshBase(source.path, source.remoteUrl, branch);
      note = base.fresh ? `based on origin/${branch} at ${base.sha.slice(0, 12)}` : `WARNING: ${base.warning}`;
      // An exact commit makes BB skip its own (SSH) fetch; verified 2026-10-15.
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
      title: `${WORKER_MARK} ${args.title}`,
      prompt: args.prompt,
      providerId: config.workerProvider || undefined,
      model: args.model ?? (config.workerModel || undefined),
      permissionMode: "full",
      parentThreadId: ariadneThreadId,
      pluginMetadata: { role: "worker", workstream: ws.name, ariadneThreadId },
    });
    const task = store.insertTask({
      workstream: ws.name,
      title: args.title,
      links: args.links ?? [],
      workerThreadId: thread.id,
      environmentId: thread.environmentId,
    });
    await bb.sdk.threads.updatePluginMetadata({ threadId: thread.id, set: { taskId: task.id } });
    store.event("worker-spawned", `${thread.id} ${note}`, ws.name, task.id);
    markActivity();
    publish();
    return { task, note };
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

  /** Archives the worker; BB then retires its worktree (see retireWorkerEnvironment). */
  async function dropTask(taskId: string): Promise<string> {
    const task = store.task(taskId);
    if (task === undefined) throw new Error(`No task ${taskId}.`);
    store.updateTask(taskId, { status: "dropped" });
    if (task.workerThreadId !== null) await bb.sdk.threads.archive({ threadId: task.workerThreadId });
    store.event("task-dropped", "", task.workstream, taskId);
    publish();
    return `Dropped ${task.title}.`;
  }

  /**
   * BB retires an archived thread's worktree on its own, about 5 minutes after
   * archive (observed 2026-10-15). In that window, warn Ariadne if work would be
   * lost (unarchiving the worker keeps it). Otherwise queue the local branch
   * for deletion once teardown finishes. A branch with unpushed commits is
   * never deleted, so committed work survives in the repo either way.
   */
  async function retireWorkerEnvironment(task: Task) {
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
      const ws = store.workstream(task.workstream);
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
    };
  }

  /** The branch checked out in a worktree, which follows `git branch -m` renames. */
  async function worktreeBranch(env: Awaited<ReturnType<typeof bb.sdk.environments.get>>): Promise<string | null> {
    return env.path === null ? env.branchName : ((await currentBranch(env.path)) ?? env.branchName);
  }

  /**
   * Records the task's current branch. The heartbeat only covers active
   * tasks, so without this a task that finishes between heartbeats keeps a
   * stale or empty branch.
   */
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

  /** Refreshes PR state for tasks with a worktree. Returns digest lines for changes. */
  async function refreshPullRequests(tasks: Task[]): Promise<Map<string, string[]>> {
    const lines = new Map<string, string[]>();
    for (const task of tasks) {
      try {
        const environmentId = await environmentIdFor(task);
        if (environmentId === null) continue;
        const env = await bb.sdk.environments.get({ environmentId });
        if (env.lifecycle.phase === "destroyed") continue;
        const pr = prSummary(await bb.sdk.environments.pullRequest({ environmentId }));
        store.updateTask(task.id, { pr, prUrl: pr?.url ?? task.prUrl, branch: await worktreeBranch(env) });
        if (pr === null) continue;
        if (pr.state === "merged" && task.status === "in-review") store.updateTask(task.id, { status: "done" });
        const signature = `${pr.state}|${pr.attention}|${pr.checks.state}`;
        if (store.digestChanged(`pr:${task.id}`, signature) && (pr.checks.state === "failing" || pr.attention !== "none")) {
          const list = lines.get(task.workstream) ?? [];
          list.push(
            `PR #${pr.number} for ${task.id} (${task.title}): state ${pr.state}, attention ${pr.attention}, checks ${pr.checks.state} (${pr.checks.failed} failed). ${pr.url}`,
          );
          lines.set(task.workstream, list);
        }
      } catch (error) {
        bb.log.warn(`pr refresh ${task.id} failed: ${String(error)}`);
      }
    }
    return lines;
  }

  async function heartbeat() {
    await processBranchCleanups();
    if (Date.now() - lastActivityAt > config.dormantMinutes * 60_000) return;
    const active = store.activeTasks();
    const digest = await refreshPullRequests(active);
    const add = (workstream: string, line: string) => digest.set(workstream, [...(digest.get(workstream) ?? []), line]);

    for (const task of active.filter((t) => t.status === "running" && t.workerThreadId !== null)) {
      const thread = await bb.sdk.threads.get({ threadId: task.workerThreadId! }).catch(() => null);
      if (thread === null || thread.status !== "idle") continue;
      const idleMinutes = (Date.now() - thread.updatedAt) / 60_000;
      if (idleMinutes >= config.stuckMinutes && store.digestChanged(`stuck:${task.id}`, String(thread.updatedAt))) {
        add(task.workstream, `Worker @thread:${task.workerThreadId} (${task.id}, ${task.title}) has been idle ${Math.round(idleMinutes)} min while its task is still running.`);
      }
    }
    for (const task of store.unharvestedDone()) {
      if (store.digestChanged(`harvest:${task.id}`, String(task.updatedAt))) {
        add(task.workstream, `Task ${task.id} (${task.title}) is done but not yet folded into notes.`);
      }
    }
    const recent = store.staging(50, Date.now() - 60 * 60_000);
    for (const entry of recent) {
      const overlap = recent.find((o) => o.service === entry.service && o.workstream !== entry.workstream);
      if (overlap !== undefined && store.digestChanged(`staging:${entry.id}`, String(overlap.id))) {
        add(entry.workstream, `Staging overlap on ${entry.service}: ${entry.branch} (${entry.workstream}) and ${overlap.branch} (${overlap.workstream}) within the last hour.`);
      }
    }

    for (const [workstream, lines] of digest) {
      const ws = store.workstream(workstream);
      if (ws === undefined || ws.archived_at !== null || lines.length === 0) continue;
      await tellAriadne(ws.ariadne_thread_id, `${PLUGIN_PREFIX} Heartbeat digest:\n- ${lines.join("\n- ")}`);
      markActivity();
    }
    if (digest.size > 0) publish();
  }

  async function workstreamView(row: WorkstreamRow): Promise<Workstream> {
    return {
      name: row.name,
      ariadneThreadId: row.ariadne_thread_id,
      projectId: row.project_id,
      projectName: await projectName(row.project_id),
      links: store.links(row),
      archived: row.archived_at !== null,
      counts: store.counts(row.name),
    };
  }

  // ------------------------------------------------------------ agent setup

  // configure() is synchronous; better-sqlite3 lets it read the workstream.
  bb.agents.configure((context) => {
    const meta = context.pluginMetadata as AriadneMetadata;
    if (meta.role === "ariadne") {
      const ws = store.workstreamByAriadne(context.thread.id);
      return {
        tools: [
          "ariadne_spawn_worker",
          "ariadne_board",
          "ariadne_task_update",
          "ariadne_notes_read",
          "ariadne_notes_write",
          "ariadne_staging",
          "ariadne_lesson_add",
          "ariadne_lesson_remove",
          ...(config.pluginProjectId === "" ? [] : ["ariadne_improve"]),
        ],
        skills: [],
        instructions: ariadneInstructions({
          workstream: ws?.name ?? String(meta.workstream ?? "unknown"),
          links: ws === undefined ? [] : store.links(ws),
          projectName: projectNames.get(ws?.project_id ?? "") ?? context.project.name,
          pluginCheckout,
        }),
      };
    }
    if (meta.role === "worker" && typeof meta.ariadneThreadId === "string") {
      return {
        tools: ["ariadne_report", "ariadne_staging_log"],
        skills: [],
        instructions: workerInstructions({
          ariadneThreadId: meta.ariadneThreadId,
          taskId: String(meta.taskId ?? "unknown"),
          // The convention is for the user's work repos, not this plugin's repo.
          branchConvention: context.project.id === config.pluginProjectId ? "" : config.branchConvention,
        }),
      };
    }
    return { tools: [], skills: [] };
  });

  bb.agents.contributeInstructions(({ threadId }) =>
    store.workstreamByAriadne(threadId) === undefined ? null : lessonsInstructions(store.lessons()),
  );

  async function requireAriadne(threadId: string): Promise<WorkstreamRow | string> {
    const ws = store.workstreamByAriadne(threadId);
    return ws ?? "Only a Ariadne thread can use this tool.";
  }

  bb.agents.registerTool({
    name: "ariadne_spawn_worker",
    description: "Spawn a worker thread for one task in its own worktree, and add the task to the board.",
    presentation: { label: { pending: "Spawning worker", completed: "Spawned worker" } },
    parameters: z.object({
      title: z.string().min(1).max(120).describe("Short task title, e.g. 'CHATINTS-2414 notify on join'"),
      prompt: z.string().min(1).describe("The full kickoff prompt for the worker"),
      links: z.array(z.string()).max(20).optional().describe("Ticket or doc URLs for the board"),
      model: z.string().optional().describe("Model override for this worker"),
      baseBranch: z.string().optional().describe("Base branch to fork from; defaults to the repo default branch"),
    }),
    async execute(args, { threadId }) {
      const ws = await requireAriadne(threadId);
      if (typeof ws === "string") return errorText(ws);
      const { task, note } = await spawnWorker(threadId, args);
      return `Spawned worker @thread:${task.workerThreadId} for task ${task.id} (${task.title}); ${note}.`;
    },
  });

  bb.agents.registerTool({
    name: "ariadne_board",
    description: "List this workstream's tasks with status, worker thread, branch and PR state.",
    presentation: { label: { pending: "Reading board", completed: "Read board" }, suppress: true },
    parameters: z.object({ status: z.enum(TASK_STATUSES).optional() }),
    async execute({ status }, { threadId }) {
      const ws = await requireAriadne(threadId);
      if (typeof ws === "string") return errorText(ws);
      const tasks = store.tasks(ws.name, status);
      if (tasks.length === 0) return "No tasks.";
      return tasks.map((t) => boardRow(t, true)).join("\n");
    },
  });

  bb.agents.registerTool({
    name: "ariadne_task_update",
    description: "Update a task on the board.",
    presentation: { label: { pending: "Updating task", completed: "Updated task" } },
    parameters: z.object({
      taskId: z.string(),
      status: z.enum(TASK_STATUSES).optional(),
      prUrl: z.string().optional(),
      summary: z.string().max(2000).optional(),
      harvested: z.boolean().optional(),
    }),
    async execute({ taskId, ...changes }, { threadId }) {
      const ws = await requireAriadne(threadId);
      if (typeof ws === "string") return errorText(ws);
      const task = store.task(taskId);
      if (task === undefined || task.workstream !== ws.name) return errorText(`No task ${taskId} in this workstream.`);
      store.updateTask(taskId, changes);
      store.event("task-updated", JSON.stringify(changes), ws.name, taskId);
      publish();
      return `Updated ${taskId}.`;
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
      "Replace a note topic with a new body. Previous versions are kept. Suggested topics: overview, people, architecture, conventions, gotchas.",
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
        .map((e) => `${new Date(e.at).toISOString()} ${e.service} ← ${e.branch} (${e.workstream}, @thread:${e.workerThreadId}): ${e.purpose}`)
        .join("\n");
    },
  });


  bb.agents.registerTool({
    name: "ariadne_lesson_add",
    description:
      "Remember a behaviour adjustment for every Ariadne, e.g. a user preference or playbook tweak. Applies from each Ariadne's next session.",
    presentation: { label: { pending: "Saving lesson", completed: "Saved lesson" } },
    parameters: z.object({ text: z.string().min(5).max(400) }),
    async execute({ text: lesson }, { threadId }) {
      const ws = await requireAriadne(threadId);
      if (typeof ws === "string") return errorText(ws);
      const id = store.addLesson(lesson, threadId);
      store.event("lesson-added", lesson, ws.name);
      publish();
      return `Saved lesson ${id}. Follow it now; other Ariadne threads pick it up at their next session.`;
    },
  });

  bb.agents.registerTool({
    name: "ariadne_lesson_remove",
    description: "Remove a lesson that is wrong or stale, by id.",
    presentation: { label: { pending: "Removing lesson", completed: "Removed lesson" } },
    parameters: z.object({ id: z.number().int() }),
    async execute({ id }, { threadId }) {
      const ws = await requireAriadne(threadId);
      if (typeof ws === "string") return errorText(ws);
      if (!store.removeLesson(id)) return errorText(`No lesson ${id}.`);
      store.event("lesson-removed", String(id), ws.name);
      publish();
      return `Removed lesson ${id}.`;
    },
  });

  bb.agents.registerTool({
    name: "ariadne_improve",
    description:
      "Fix or improve Ariadne itself. Spawns a worker in the plugin repo that makes the change and opens a draft PR for the user to review. Nothing changes in the running plugin until the user merges and asks you to apply it.",
    presentation: { label: { pending: "Starting a Ariadne improvement", completed: "Started a Ariadne improvement" } },
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
      const { task, note } = await spawnWorker(threadId, {
        title: `Improve Ariadne: ${title}`,
        prompt: improvementKickoff({ problem, evidence, proposal, requestedBy: threadId, repo: `${remote.owner}/${remote.repo}` }),
        projectId: config.pluginProjectId,
      });
      store.event("improvement-started", title, ws.name, task.id);
      return `Started improvement worker @thread:${task.workerThreadId} (task ${task.id}); ${note}. It will report a draft PR.`;
    },
  });

  bb.agents.registerTool({
    name: "ariadne_report",
    description: "Report to your Ariadne manager: pr-opened, blocked, done or fyi.",
    presentation: { label: { pending: "Reporting to Ariadne", completed: "Reported to Ariadne" } },
    parameters: z.object({
      status: z.enum(["pr-opened", "blocked", "done", "fyi"]),
      note: z.string().min(1).max(4000),
      prUrl: z.string().optional(),
    }),
    async execute({ status, note, prUrl }, { threadId }) {
      const meta = await metadataOf(threadId);
      const task = store.taskByWorker(threadId);
      if (meta.role !== "worker" || meta.ariadneThreadId === undefined || task === undefined) {
        return errorText("This thread is not a Ariadne worker.");
      }
      const statusChange = { "pr-opened": "in-review", blocked: "blocked", done: "done", fyi: undefined } as const;
      // "done" with an unmerged PR still needs the user's review, so keep it visible.
      const hasOpenPr = (prUrl ?? task.prUrl) !== null && task.pr?.state !== "merged";
      store.updateTask(task.id, {
        status: status === "done" && hasOpenPr ? "in-review" : statusChange[status],
        prUrl: prUrl ?? undefined,
        summary: status === "done" ? note.slice(0, 2000) : undefined,
      });
      await refreshBranch(task);
      store.event(`report-${status}`, note, task.workstream, task.id);
      markActivity();
      publish();
      await tellAriadne(
        meta.ariadneThreadId,
        `${PLUGIN_PREFIX} Worker @thread:${threadId} (${task.id}, ${task.title}) reports ${status}${prUrl ? ` ${prUrl}` : ""}: ${note}`,
        threadId,
      );
      return "Reported to Ariadne.";
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
      const task = store.taskByWorker(threadId);
      if (task === undefined) return errorText("This thread is not a Ariadne worker.");
      store.logStaging({ workstream: task.workstream, workerThreadId: threadId, taskId: task.id, service, branch, purpose });
      store.updateTask(task.id, { branch });
      store.event("staging", `${service} ${branch}`, task.workstream, task.id);
      markActivity();
      publish();
      return "Logged.";
    },
  });

  // ----------------------------------------------------------------- events

  // BB's native child-completed notification tells Ariadne when a worker
  // finishes (spike finding 1). These handlers cover what BB does not.
  bb.events.on("interaction.pending", async ({ thread, interaction }) => {
    if (thread.originPluginId !== bb.pluginId) return;
    const task = store.taskByWorker(thread.id);
    if (task === undefined) return;
    const ws = store.workstream(task.workstream);
    if (ws === undefined) return;
    markActivity();
    await tellAriadne(
      ws.ariadne_thread_id,
      `${PLUGIN_PREFIX} Worker @thread:${thread.id} (${task.id}, ${task.title}) is waiting on ${describeInteraction(interaction)}. It is stalled until someone answers in that thread.`,
      thread.id,
    );
  });

  bb.events.on("thread.archived", async ({ thread }) => {
    if (thread.originPluginId !== bb.pluginId) return;
    const ws = store.workstreamByAriadne(thread.id);
    if (ws !== undefined) {
      store.archiveWorkstream(ws.name);
      publish();
      return;
    }
    const task = store.taskByWorker(thread.id);
    if (task === undefined) return;
    if (task.status === "running" || task.status === "blocked") store.updateTask(task.id, { status: "dropped" });
    publish();
    try {
      await retireWorkerEnvironment(task);
    } catch (error) {
      bb.log.warn(`retire worktree ${task.id} failed: ${String(error)}`);
    }
  });

  bb.events.on("thread.unarchived", ({ thread }) => {
    const ws = store.workstreamByAriadne(thread.id);
    if (ws === undefined || ws.archived_at === null) return;
    store.unarchiveWorkstream(ws.name);
    publish();
  });

  bb.events.on("thread.active", ({ thread }) => {
    if (thread.originPluginId === bb.pluginId) markActivity();
  });
  bb.events.on("thread.idle", ({ thread }) => {
    if (thread.originPluginId === bb.pluginId) markActivity();
  });

  bb.background.schedule("heartbeat", HEARTBEAT_CRON, heartbeat);

  // -------------------------------------------------------------------- RPC

  bb.rpc.register(rpcContract, {
    overview: async () => ({
      workstreams: await Promise.all(store.workstreams().map(workstreamView)),
    }),
    projects: async () => {
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      return { projects: projects.map((p) => ({ id: p.id, name: p.name, kind: p.kind })) };
    },
    workstream_create: async ({ name, projectId, links }) => ({
      ariadneThreadId: await createWorkstream(name, projectId, links),
    }),
    workstream_archive: async ({ name }) => {
      const ws = store.workstream(name);
      if (ws === undefined) throw new Error(`No workstream ${name}.`);
      await bb.sdk.threads.archive({ threadId: ws.ariadne_thread_id });
      store.archiveWorkstream(name);
      publish();
      return { ok: true };
    },
    board: async ({ workstream }) => ({ tasks: store.tasks(workstream) }),
    task_drop_preview: async ({ taskId }) => {
      const task = store.task(taskId);
      return { risk: task === undefined ? null : await workAtRisk(task) };
    },
    task_drop: async ({ taskId }) => ({ ok: true, detail: await dropTask(taskId) }),
    lessons: async () => ({ lessons: store.lessons() }),
    lesson_remove: async ({ id }) => {
      const ok = store.removeLesson(id);
      if (ok) store.event("lesson-removed", `${id} (from UI)`);
      publish();
      return { ok };
    },
    notes: async ({ workstream }) => ({ notes: store.notes(workstream) }),
    staging: async ({ limit }) => ({ entries: store.staging(limit) }),
    thread_context: async ({ threadId }) => {
      const ws = store.workstreamByAriadne(threadId);
      if (ws !== undefined) return { role: "ariadne" as const, workstream: ws.name, taskId: null };
      const task = store.taskByWorker(threadId);
      if (task !== undefined) return { role: "worker" as const, workstream: task.workstream, taskId: task.id };
      return { role: "none" as const, workstream: null, taskId: null };
    },
  });

  // -------------------------------------------------------------------- CLI
  // For agents and scripting; the user works through the UI.

  bb.cli.register(
    defineCli({
      name: "ariadne",
      summary: "Ariadne manager threads: workstreams, boards, notes and the staging log",
      commands: {
        create: cliCommand({
          summary: "Create a workstream and its Ariadne thread",
          positionals: [{ name: "workstream", description: "Workstream name", required: true }],
          options: {
            project: { type: "string", description: "Project id (defaults to the invoking thread's project)" },
            link: { type: "string", repeatable: true, description: "Link to attach (repeatable)" },
          },
          async run(input, ctx) {
            const projectId = input.options.project ?? ctx.projectId;
            if (projectId === undefined) {
              throw new PluginCliError("no project", { code: "missing_project", hint: "Pass --project <id> (bb project list)." });
            }
            const id = await createWorkstream(input.positionals.workstream, projectId, [input.options.link ?? []].flat());
            return { exitCode: 0, stdout: `Created Ariadne ${id} for "${input.positionals.workstream}".` };
          },
        }),
        list: cliCommand({
          summary: "List workstreams",
          async run() {
            const rows = await Promise.all(store.workstreams().map(workstreamView));
            const lines = rows.map(
              (w) =>
                `${w.name}${w.archived ? " (archived)" : ""}  ariadne=${w.ariadneThreadId}  project=${w.projectName ?? w.projectId}  running=${w.counts.running} blocked=${w.counts.blocked} in-review=${w.counts.inReview} done=${w.counts.done}`,
            );
            return { exitCode: 0, stdout: lines.length === 0 ? "No workstreams." : lines.join("\n") };
          },
        }),
        board: cliCommand({
          summary: "Show a workstream's tasks",
          positionals: [{ name: "workstream", description: "Workstream name", required: true }],
          async run(input) {
            const tasks = store.tasks(input.positionals.workstream);
            const lines = tasks.map((t) => boardRow(t, false));
            return { exitCode: 0, stdout: lines.length === 0 ? "No tasks." : lines.join("\n") };
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
