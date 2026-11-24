// Tracks who started each worker turn so Ariadne can tell a worker's report
// apart from a user conversation, an orchestrator auto-reaction, or a wake from
// a background task. Backed by SQLite via TurnStateStore so plugin reloads
// preserve streak state.

export type TurnStarter = "user" | "ariadne" | "orchestrator" | "background";

export interface TurnStateRecord {
  startedBy: TurnStarter | null;
  reported: boolean;
  flaggedStreak: "user" | "background" | null;
}

export interface TurnStateStore {
  get(workerThreadId: string): TurnStateRecord | undefined;
  set(workerThreadId: string, record: TurnStateRecord): void;
  delete(workerThreadId: string): void;
}

function memoryTurnStore(): TurnStateStore {
  const map = new Map<string, TurnStateRecord>();
  return {
    get: (id) => map.get(id),
    set: (id, rec) => {
      map.set(id, rec);
    },
    delete: (id) => {
      map.delete(id);
    },
  };
}

export class WorkerTurns {
  private readonly store: TurnStateStore;

  constructor(store?: TurnStateStore) {
    this.store = store ?? memoryTurnStore();
  }

  private read(workerThreadId: string): TurnStateRecord {
    return this.store.get(workerThreadId) ?? { startedBy: null, reported: false, flaggedStreak: null };
  }

  /** A message started a worker turn; "user" when the user typed it in the worker thread. */
  started(workerThreadId: string, by: "user" | "ariadne" | "orchestrator") {
    const prev = this.read(workerThreadId);
    this.store.set(workerThreadId, {
      startedBy: by,
      reported: false,
      flaggedStreak: prev.flaggedStreak,
    });
  }

  /** The worker went active. With no recorded start, its own background task woke it. */
  active(workerThreadId: string) {
    const prev = this.read(workerThreadId);
    if (prev.startedBy === null) {
      this.store.set(workerThreadId, {
        startedBy: "background",
        reported: false,
        flaggedStreak: prev.flaggedStreak,
      });
    }
  }

  /** Ariadne or the orchestrator steered the running turn, so its completion answers orchestration. */
  steered(workerThreadId: string, by: "ariadne" | "orchestrator" = "ariadne") {
    const prev = this.read(workerThreadId);
    if (prev.startedBy !== null) {
      this.store.set(workerThreadId, { ...prev, startedBy: by });
    }
  }

  /** The worker sent a substantive report (pr-opened, blocked, done) or registered a watch this turn. */
  reported(workerThreadId: string) {
    const prev = this.read(workerThreadId);
    this.store.set(workerThreadId, {
      startedBy: prev.startedBy ?? "ariadne",
      reported: true,
      flaggedStreak: prev.flaggedStreak,
    });
  }

  /**
   * The worker's turn ended. Returns who started it when Ariadne should be
   * told before BB's completion notice: the first user or background turn
   * since Ariadne/orchestrator last steered the worker or it last reported.
   */
  finished(workerThreadId: string): "user" | "background" | null {
    const cur = this.store.get(workerThreadId);
    if (cur === undefined || cur.startedBy === null) return null;
    if (cur.startedBy === "ariadne" || cur.startedBy === "orchestrator" || cur.reported) {
      this.store.set(workerThreadId, { startedBy: null, reported: false, flaggedStreak: null });
      return null;
    }
    const by = cur.startedBy;
    if (cur.flaggedStreak === by) {
      this.store.set(workerThreadId, { startedBy: null, reported: false, flaggedStreak: by });
      return null;
    }
    this.store.set(workerThreadId, { startedBy: null, reported: false, flaggedStreak: by });
    return by;
  }

  clear(workerThreadId: string) {
    this.store.delete(workerThreadId);
  }
}

// PR attention states that need nobody: the worker already reported the PR,
// and these change often (a draft flips through checks_pending as CI starts).
const QUIET_PR_ATTENTION = new Set(["none", "draft", "checks_pending", "queued"]);

/** Whether a PR change is worth attention. */
export function prNeedsAttention(pr: { attention: string; checks: { state: string } }): boolean {
  return pr.checks.state === "failing" || !QUIET_PR_ATTENTION.has(pr.attention);
}
