// Tracks who started each worker turn, so Ariadne can tell a worker's report
// to it apart from a conversation the user is having with the worker, or a
// wake from the worker's own background task. BB's child-completed notice
// says none of this, and it reaches Ariadne without passing the plugin's
// message.dispatch hook (README, 2026-11-02), so the plugin cannot drop or
// label it. Instead it sends Ariadne one note per streak of such turns, just
// before BB's notice. State is in memory; after a plugin restart nothing is
// known, so no notes go out until the next turn starts.

export type TurnStarter = "user" | "ariadne" | "background";

export class WorkerTurns {
  private turns = new Map<string, { by: TurnStarter; reported: boolean }>();
  /** Workers whose current streak of user or background turns Ariadne has been told about. */
  private flagged = new Map<string, TurnStarter>();

  /** A message started a worker turn; "user" when the user typed it in the worker thread. */
  started(workerThreadId: string, by: "user" | "ariadne") {
    this.turns.set(workerThreadId, { by, reported: false });
  }

  /** The worker went active. With no recorded start, its own background task woke it. */
  active(workerThreadId: string) {
    if (!this.turns.has(workerThreadId)) this.turns.set(workerThreadId, { by: "background", reported: false });
  }

  /** Ariadne steered the running turn, so its completion answers Ariadne. */
  steered(workerThreadId: string) {
    const turn = this.turns.get(workerThreadId);
    if (turn !== undefined) this.turns.set(workerThreadId, { ...turn, by: "ariadne" });
  }

  /** The worker sent a pr-opened, blocked or done report this turn. */
  reported(workerThreadId: string) {
    const turn = this.turns.get(workerThreadId) ?? { by: "ariadne", reported: false };
    this.turns.set(workerThreadId, { ...turn, reported: true });
  }

  /**
   * The worker's turn ended. Returns who started it when Ariadne should be
   * told before BB's completion notice: the first user or background turn
   * since Ariadne last steered the worker or the worker last reported.
   */
  finished(workerThreadId: string): "user" | "background" | null {
    const turn = this.turns.get(workerThreadId);
    this.turns.delete(workerThreadId);
    if (turn === undefined) return null;
    if (turn.by === "ariadne" || turn.reported) {
      this.flagged.delete(workerThreadId);
      return null;
    }
    if (this.flagged.get(workerThreadId) === turn.by) return null;
    this.flagged.set(workerThreadId, turn.by);
    return turn.by;
  }
}

// PR attention states that need nobody: the worker already reported the PR,
// and these change often (a draft flips through checks_pending as CI starts).
const QUIET_PR_ATTENTION = new Set(["none", "draft", "checks_pending", "queued"]);

/** Whether a PR change is worth a heartbeat digest line. */
export function prNeedsAttention(pr: { attention: string; checks: { state: string } }): boolean {
  return pr.checks.state === "failing" || !QUIET_PR_ATTENTION.has(pr.attention);
}
