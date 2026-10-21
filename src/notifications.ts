// Decides when BB's native child-completed notice would tell Ariadne something
// it already knows: the worker reported during that turn, or the user started
// the turn by talking to the worker directly. State is in memory; after a
// plugin restart nothing is known, so every notice goes through as before.

/** The worker thread a `[bb system] @thread:<id> completed:` message is about, or null. */
export function completedWorkerId(text: string): string | null {
  return /^\[bb system\]\s*@thread:(thr_[a-z0-9]+) completed:/.exec(text)?.[1] ?? null;
}

export class WorkerTurns {
  private turns = new Map<string, { byUser: boolean; reported: boolean }>();

  /** A new worker turn started; `byUser` when the user typed it in the worker thread. */
  started(workerThreadId: string, byUser: boolean) {
    this.turns.set(workerThreadId, { byUser, reported: false });
  }

  /** The worker sent a pr-opened, blocked or done report this turn. */
  reported(workerThreadId: string) {
    const turn = this.turns.get(workerThreadId) ?? { byUser: false, reported: false };
    this.turns.set(workerThreadId, { ...turn, reported: true });
  }

  /** Why the completion of the worker's latest turn is redundant, or null if Ariadne needs it. */
  redundant(workerThreadId: string): string | null {
    const turn = this.turns.get(workerThreadId);
    if (turn?.reported) return "the worker already reported to Ariadne this turn";
    if (turn?.byUser) return "the user started this turn in the worker thread";
    return null;
  }

  /** Forward the next completion, for example after Ariadne steers the running turn. */
  forget(workerThreadId: string) {
    this.turns.delete(workerThreadId);
  }
}
