// bb-plugin-cyril — spike.
//
// Cyril is a manager thread for one workstream. It spawns worker threads,
// hears when they go idle or fail, and receives explicit reports from them.
// This spike exists to answer four questions before the real design:
//
//   1. What does BB's native parent notification look like on Cyril?
//   2. Does plugin forwarding duplicate it?
//   3. Can configure() give Cyril and workers different tools by metadata?
//   4. Does threads.send({ mode: "auto" }) wake an idle Cyril?
//
// Every relevant event is appended to a debug log (`bb cyril debug`) so the
// answers come from observation rather than reading docs.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

type Role = "cyril" | "worker";

interface CyrilMetadata {
  role?: Role;
  workstream?: string;
  cyrilThreadId?: string;
}

interface DebugEntry {
  at: string;
  kind: string;
  threadId: string;
  detail: string;
}

const DEBUG_KEY = "debug-log";
const DEBUG_LIMIT = 200;

const CYRIL_INSTRUCTIONS = [
  "You are Cyril, the manager for one workstream. You are the user's main point of contact.",
  "Spawn workers with the cyril_spawn_worker tool. You may spawn and steer workers without asking.",
  "Messages starting with [cyril] come from the Cyril plugin or a worker, not the user.",
].join("\n");

const WORKER_INSTRUCTIONS = [
  "You are a worker managed by a Cyril manager thread.",
  "Use the cyril_report tool to tell Cyril when you open a PR, get blocked, or finish.",
].join("\n");

function text(value: string) {
  return [{ type: "text" as const, text: value, mentions: [] }];
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    linkWorkersAsChildren: {
      type: "boolean",
      label: "Spawn workers as child threads of Cyril (native parent notifications)",
      default: true,
    },
    forwardWorkerIdle: {
      type: "boolean",
      label: "Forward worker idle/failed events to Cyril from the plugin",
      default: true,
    },
  });
  const { linkWorkersAsChildren, forwardWorkerIdle } = await settings.get();

  async function debug(kind: string, threadId: string, detail: string) {
    const log = (await bb.storage.kv.get<DebugEntry[]>(DEBUG_KEY)) ?? [];
    log.push({ at: new Date().toISOString(), kind, threadId, detail });
    await bb.storage.kv.set(DEBUG_KEY, log.slice(-DEBUG_LIMIT));
  }

  async function metadataOf(threadId: string): Promise<CyrilMetadata> {
    return (await bb.sdk.threads.getPluginMetadata({ threadId })) as CyrilMetadata;
  }

  async function tellCyril(cyrilThreadId: string, message: string, senderThreadId?: string) {
    const result = await bb.sdk.threads.send({
      threadId: cyrilThreadId,
      mode: "auto",
      input: text(message),
      senderThreadId,
    });
    await debug("sent-to-cyril", cyrilThreadId, JSON.stringify(result).slice(0, 300));
  }

  // configure() is synchronous and sees this plugin's metadata on the thread,
  // so role-specific tools and instructions need no lookup.
  bb.agents.configure((context) => {
    const role = context.pluginMetadata.role;
    if (role === "cyril") {
      return { tools: ["cyril_spawn_worker"], skills: [], instructions: CYRIL_INSTRUCTIONS };
    }
    if (role === "worker") {
      return { tools: ["cyril_report"], skills: [], instructions: WORKER_INSTRUCTIONS };
    }
    return { tools: [], skills: [] };
  });

  bb.agents.registerTool({
    name: "cyril_spawn_worker",
    description: "Spawn a worker thread for one task in this workstream.",
    parameters: z.object({
      title: z.string().min(1).max(120),
      prompt: z.string().min(1),
      model: z.string().optional(),
    }),
    async execute({ title, prompt, model }, { threadId, projectId }) {
      const cyril = await metadataOf(threadId);
      if (cyril.role !== "cyril") {
        return { content: [{ type: "text", text: "Only a Cyril thread can spawn workers." }], isError: true };
      }
      const worker = await bb.sdk.threads.spawn({
        projectId,
        environment: { type: "host", workspace: { type: "personal" } },
        title,
        prompt,
        model,
        parentThreadId: linkWorkersAsChildren ? threadId : undefined,
        pluginMetadata: { role: "worker", workstream: cyril.workstream ?? null, cyrilThreadId: threadId },
      });
      await debug("spawned-worker", worker.id, `cyril=${threadId} child=${linkWorkersAsChildren}`);
      return `Spawned worker ${worker.id} (${title}).`;
    },
  });

  bb.agents.registerTool({
    name: "cyril_report",
    description: "Send a one-line status report to your Cyril manager thread.",
    parameters: z.object({
      status: z.enum(["pr-opened", "blocked", "done", "fyi"]),
      note: z.string().min(1).max(2000),
    }),
    async execute({ status, note }, { threadId }) {
      const worker = await metadataOf(threadId);
      if (worker.role !== "worker" || worker.cyrilThreadId === undefined) {
        return { content: [{ type: "text", text: "This thread is not a Cyril worker." }], isError: true };
      }
      await debug("worker-report", threadId, `${status}: ${note}`);
      await tellCyril(worker.cyrilThreadId, `[cyril] Worker ${threadId} reports ${status}: ${note}`, threadId);
      return "Reported to Cyril.";
    },
  });

  async function onWorkerLifecycle(kind: "idle" | "failed", threadId: string, originPluginId: string | null, detail: string | null) {
    // Cheap filter first: only threads this plugin spawned can be workers.
    if (originPluginId !== bb.pluginId) return;
    const worker = await metadataOf(threadId);
    if (worker.role !== "worker" || worker.cyrilThreadId === undefined) return;
    await debug(`worker-${kind}`, threadId, (detail ?? "").slice(0, 300));
    if (!forwardWorkerIdle) return;
    const summary = (detail ?? "(no output)").slice(0, 1500);
    await tellCyril(worker.cyrilThreadId, `[cyril] Worker ${threadId} is ${kind}. Last output:\n\n${summary}`);
  }

  bb.events.on("thread.idle", ({ thread, lastAssistantText }) =>
    onWorkerLifecycle("idle", thread.id, thread.originPluginId, lastAssistantText),
  );
  bb.events.on("thread.failed", ({ thread, error }) =>
    onWorkerLifecycle("failed", thread.id, thread.originPluginId, error),
  );

  // Record Cyril's own transitions so we can see whether native parent
  // notifications or plugin sends woke it (question 1, 2 and 4).
  bb.events.on("thread.active", async ({ thread }) => {
    if (thread.originPluginId !== bb.pluginId) return;
    const meta = await metadataOf(thread.id);
    if (meta.role === "cyril") await debug("cyril-active", thread.id, "");
  });

  const usage = [
    "Usage:",
    "  bb cyril create <workstream> [--project <id>]",
    "  bb cyril debug [--clear]",
  ].join("\n");

  bb.cli.register({
    name: "cyril",
    summary: "Create Cyril manager threads and inspect the spike debug log",
    commands: [
      { name: "create", summary: "Create a Cyril thread for a workstream", usage: "bb cyril create <workstream> [--project <id>]" },
      { name: "debug", summary: "Show or clear the spike debug log", usage: "bb cyril debug [--clear]" },
    ],
    async run(argv, ctx) {
      const [command, ...args] = argv;
      if (command === "create") {
        const projectFlag = args.indexOf("--project");
        const projectId = projectFlag >= 0 ? args[projectFlag + 1] : ctx.projectId;
        const workstream = args.filter((_, i) => i !== projectFlag && i !== projectFlag + 1).join(" ").trim();
        if (workstream === "" || projectId === undefined) return { exitCode: 1, stderr: usage };
        const thread = await bb.sdk.threads.spawn({
          projectId,
          environment: { type: "host", workspace: { type: "personal" } },
          title: `Cyril · ${workstream}`,
          prompt: `You are Cyril for the "${workstream}" workstream. Introduce yourself in one sentence and wait for instructions.`,
          pinned: true,
          pluginMetadata: { role: "cyril", workstream },
        });
        await debug("created-cyril", thread.id, workstream);
        return { exitCode: 0, stdout: `Created Cyril ${thread.id} for "${workstream}".` };
      }
      if (command === "debug") {
        if (args.includes("--clear")) {
          await bb.storage.kv.set(DEBUG_KEY, []);
          return { exitCode: 0, stdout: "Cleared." };
        }
        const log = (await bb.storage.kv.get<DebugEntry[]>(DEBUG_KEY)) ?? [];
        const lines = log.map((e) => `${e.at}  ${e.kind.padEnd(16)} ${e.threadId}  ${e.detail}`);
        return { exitCode: 0, stdout: lines.length === 0 ? "Empty." : lines.join("\n") };
      }
      return { exitCode: command === undefined || command === "help" ? 0 : 1, stdout: usage };
    },
  });
}
