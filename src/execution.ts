// Provider/model/reasoning/service-tier configuration shared by settings,
// workstream creation, worker spawning, and UI display. No SDK imports so both
// server.ts and app.tsx can import it cleanly.
import { REASONING_LEVELS, type ReasoningLevel } from "./constants.ts";

export interface ExecutionConfig {
  providerId: string | null;
  model: string | null;
  reasoningLevel: ReasoningLevel | null;
  serviceTier: string | null;
}

export interface AgentDefaults {
  ariadne: ExecutionConfig;
  worker: ExecutionConfig;
}

export const EMPTY_EXECUTION: ExecutionConfig = {
  providerId: null,
  model: null,
  reasoningLevel: null,
  serviceTier: null,
};

export const DEFAULT_AGENT_DEFAULTS: AgentDefaults = {
  ariadne: { ...EMPTY_EXECUTION },
  worker: { ...EMPTY_EXECUTION },
};

const REASONING_SET = new Set<string>(REASONING_LEVELS);

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return typeof value === "string" && REASONING_SET.has(value);
}

export function normalizeExecution(input?: Partial<Record<keyof ExecutionConfig, unknown>> | null): ExecutionConfig {
  if (input === null || input === undefined) return { ...EMPTY_EXECUTION };
  const rawReasoning = cleanString(input.reasoningLevel);
  return {
    providerId: cleanString(input.providerId),
    model: cleanString(input.model),
    reasoningLevel: rawReasoning !== null && isReasoningLevel(rawReasoning) ? rawReasoning : null,
    serviceTier: cleanString(input.serviceTier),
  };
}

export function normalizeAgentDefaults(input?: Partial<{ ariadne: unknown; worker: unknown }> | null): AgentDefaults {
  return {
    ariadne: normalizeExecution(
      input?.ariadne && typeof input.ariadne === "object"
        ? (input.ariadne as Partial<Record<keyof ExecutionConfig, unknown>>)
        : null,
    ),
    worker: normalizeExecution(
      input?.worker && typeof input.worker === "object"
        ? (input.worker as Partial<Record<keyof ExecutionConfig, unknown>>)
        : null,
    ),
  };
}

export function hasExecutionOverrides(exec: ExecutionConfig): boolean {
  return (
    exec.providerId !== null ||
    exec.model !== null ||
    exec.reasoningLevel !== null ||
    exec.serviceTier !== null
  );
}

export function parseExecutionJson(json: string | null | undefined): ExecutionConfig {
  if (!json) return { ...EMPTY_EXECUTION };
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== "object") return { ...EMPTY_EXECUTION };
    return normalizeExecution(parsed as Partial<Record<keyof ExecutionConfig, unknown>>);
  } catch {
    return { ...EMPTY_EXECUTION };
  }
}

export function serializeExecutionJson(exec?: Partial<ExecutionConfig> | null): string | null {
  const normalized = normalizeExecution(exec);
  return hasExecutionOverrides(normalized) ? JSON.stringify(normalized) : null;
}

/**
 * Merges a higher-precedence override onto a base execution config.
 * Switching providers drops base model/reasoning/tier so incompatible options
 * never cross providers; switching models drops base reasoning/tier.
 */
export function mergeExecution(base: ExecutionConfig, override?: Partial<ExecutionConfig> | null): ExecutionConfig {
  const b = normalizeExecution(base);
  const o = normalizeExecution(override);
  if (!hasExecutionOverrides(o)) return b;
  if (o.providerId !== null && o.providerId !== b.providerId) {
    return o;
  }
  const providerId = o.providerId ?? b.providerId;
  if (o.model !== null && o.model !== b.model) {
    return {
      providerId,
      model: o.model,
      reasoningLevel: o.reasoningLevel,
      serviceTier: o.serviceTier,
    };
  }
  return {
    providerId,
    model: o.model ?? b.model,
    reasoningLevel: o.reasoningLevel ?? b.reasoningLevel,
    serviceTier: o.serviceTier ?? b.serviceTier,
  };
}

export interface SpawnExecutionArgs {
  providerId?: string;
  model?: string;
  reasoningLevel?: ReasoningLevel;
  serviceTier?: string;
  executionInputSources?: {
    providerId?: "explicit";
    model?: "explicit";
    reasoningLevel?: "explicit";
    serviceTier?: "explicit";
    permissionMode?: "explicit";
  };
}

export function toSpawnExecutionArgs(exec: ExecutionConfig, markPermissionExplicit = true): SpawnExecutionArgs {
  const normalized = normalizeExecution(exec);
  const sources: NonNullable<SpawnExecutionArgs["executionInputSources"]> = {};
  const args: SpawnExecutionArgs = {};
  if (normalized.providerId !== null) {
    args.providerId = normalized.providerId;
    sources.providerId = "explicit";
  }
  if (normalized.model !== null) {
    args.model = normalized.model;
    sources.model = "explicit";
  }
  if (normalized.reasoningLevel !== null) {
    args.reasoningLevel = normalized.reasoningLevel;
    sources.reasoningLevel = "explicit";
  }
  if (normalized.serviceTier !== null) {
    args.serviceTier = normalized.serviceTier;
    sources.serviceTier = "explicit";
  }
  if (Object.keys(sources).length > 0) {
    if (markPermissionExplicit) sources.permissionMode = "explicit";
    args.executionInputSources = sources;
  }
  return args;
}

export function formatExecutionSummary(exec: ExecutionConfig): string | null {
  const normalized = normalizeExecution(exec);
  if (!hasExecutionOverrides(normalized)) return null;
  const head =
    normalized.providerId && normalized.model
      ? `${normalized.providerId} / ${normalized.model}`
      : (normalized.model ?? normalized.providerId);
  const parts: string[] = [];
  if (head) parts.push(head);
  if (normalized.reasoningLevel) parts.push(normalized.reasoningLevel);
  if (normalized.serviceTier && normalized.serviceTier !== "default") parts.push(normalized.serviceTier);
  return parts.join(" · ");
}
