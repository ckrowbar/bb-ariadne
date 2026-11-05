// bb-plugin-ariadne — frontend entry.
//
// Every key human interaction is a click here (docs/v0-spec.md, UI):
// - Ariadne sidebar page: workstreams, New workstream, and per workstream the
//   Board, Notes and Staging tabs.
// - "Ariadne board" thread panel: the same board beside a Ariadne or worker chat.
// - Home page section: each active workstream with task counts.
// Data comes over plugin RPC; the server's realtime signal refreshes views.
import { useCallback, useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  Markdown,
  UrlLink,
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import type { DeletionPreview, Note, StagingEntry, Task, Workstream, rpcContract } from "./src/contract";
import { CHANGED_CHANNEL, type TaskStatus } from "./src/constants";
import { workstreamFromSubPath } from "./src/route";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const PANEL_PATH = "ariadne";

/** Calls an RPC method and refetches whenever the server signals a change. */
function useLive<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    load().then(
      (value) => {
        setData(value);
        setError(null);
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, deps);
  useEffect(refetch, [refetch]);
  useRealtime(CHANGED_CHANNEL, refetch);
  return { data, error, refetch };
}

function relativeTime(ms: number): string {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  return error === null ? null : (
    <p role="alert" className="mt-3 text-sm text-destructive">
      {error}
    </p>
  );
}

const STATUS_STYLE: Record<TaskStatus, string> = {
  running: "bg-primary/15 text-primary",
  blocked: "bg-destructive/15 text-destructive",
  "in-review": "bg-secondary text-secondary-foreground",
  done: "bg-muted text-muted-foreground",
  dropped: "bg-muted text-muted-foreground line-through",
};

function Pill({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", className)}>
      {children}
    </span>
  );
}

function PrBadge({ task }: { task: Task }) {
  if (task.pr === null) {
    return task.prUrl === null ? (
      <span className="text-xs text-muted-foreground">No PR</span>
    ) : (
      <UrlLink href={task.prUrl} className="text-xs underline-offset-4 hover:underline">
        PR
      </UrlLink>
    );
  }
  const checks = task.pr.checks;
  const checkStyle =
    checks.state === "failing"
      ? "text-destructive"
      : checks.state === "passing"
        ? "text-primary"
        : "text-muted-foreground";
  return (
    <span className="flex items-center gap-2 text-xs">
      <UrlLink href={task.pr.url} className="font-medium underline-offset-4 hover:underline">
        #{task.pr.number} {task.pr.state}
      </UrlLink>
      <span className={checkStyle}>
        {checks.state === "unknown" ? "checks ?" : `checks ${checks.passed}/${checks.passed + checks.failed + checks.pending}`}
      </span>
    </span>
  );
}

// ------------------------------------------------------------------ board

function BoardTable({ workstream, compact = false }: { workstream: string; compact?: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { data, error, refetch } = useLive(() => rpc.call("board", { workstream }), [rpc, workstream]);
  const [dropping, setDropping] = useState<Task | null>(null);
  const [risk, setRisk] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    setRisk(undefined);
    if (dropping === null) return;
    rpc.call("task_drop_preview", { taskId: dropping.id }).then(
      (result) => setRisk(result.risk),
      () => setRisk(null),
    );
  }, [dropping, rpc]);
  const [showClosed, setShowClosed] = useState(false);

  if (data === null) return error === null ? <EmptyState>Loading board…</EmptyState> : <ErrorLine error={error} />;
  const visible = data.tasks.filter((t) => showClosed || (t.status !== "done" && t.status !== "dropped"));
  const closedCount = data.tasks.length - data.tasks.filter((t) => t.status !== "done" && t.status !== "dropped").length;

  return (
    <div>
      {visible.length === 0 ? (
        <EmptyState>No open tasks. Hand Ariadne a ticket in its thread.</EmptyState>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {visible.map((task) => (
            <li key={task.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm">
              <Pill className={STATUS_STYLE[task.status]}>{task.status}</Pill>
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left font-medium hover:underline"
                disabled={task.workerThreadId === null}
                onClick={() => task.workerThreadId !== null && navigate.toThread(task.workerThreadId)}
                title="Open the worker thread"
              >
                {task.title}
              </button>
              <PrBadge task={task} />
              {compact ? null : (
                <span className="hidden text-xs text-muted-foreground md:inline">{relativeTime(task.updatedAt)}</span>
              )}
              {task.status === "done" || task.status === "dropped" ? null : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={() => setDropping(task)}
                  aria-label={`Drop ${task.title}`}
                >
                  Drop
                </Button>
              )}
              {task.summary === null || compact ? null : (
                <p className="w-full text-xs text-muted-foreground">{task.summary}</p>
              )}
            </li>
          ))}
        </ul>
      )}
      {closedCount > 0 ? (
        <Button variant="link" size="sm" className="mt-1 px-0" onClick={() => setShowClosed((v) => !v)}>
          {showClosed ? "Hide" : "Show"} {closedCount} done or dropped
        </Button>
      ) : null}
      <Dialog open={dropping !== null} onOpenChange={(open) => !open && setDropping(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Drop “{dropping?.title}”?</DialogTitle>
            <DialogDescription>
              This archives the worker thread. BB removes its worktree about five minutes later. Branches with
              unpushed commits are kept.
            </DialogDescription>
          </DialogHeader>
          {risk === undefined ? (
            <p className="text-sm text-muted-foreground">Checking for unsaved work…</p>
          ) : risk === null ? null : (
            <p role="alert" className="whitespace-pre-wrap rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              Work at risk: {risk}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDropping(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const task = dropping;
                setDropping(null);
                if (task !== null) void rpc.call("task_drop", { taskId: task.id }).then(refetch, refetch);
              }}
            >
              Drop task
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ------------------------------------------------------------------ notes

function NotesView({ workstream }: { workstream: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const { data, error } = useLive(() => rpc.call("notes", { workstream }), [rpc, workstream]);
  const [openHistory, setOpenHistory] = useState<string | null>(null);
  if (data === null) return error === null ? <EmptyState>Loading notes…</EmptyState> : <ErrorLine error={error} />;
  if (data.notes.length === 0) {
    return <EmptyState>No notes yet. Ariadne writes them as workers finish.</EmptyState>;
  }
  return (
    <div className="space-y-4">
      {data.notes.map((note: Note) => (
        <section key={note.topic} className="rounded-lg border border-border bg-card px-4 py-3">
          <header className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">{note.topic}</h3>
            <span className="text-xs text-muted-foreground">
              rev {note.revision} · {relativeTime(note.updatedAt)}
            </span>
            {note.history.length > 0 ? (
              <Button
                variant="link"
                size="sm"
                className="ml-auto h-auto px-0"
                onClick={() => setOpenHistory(openHistory === note.topic ? null : note.topic)}
              >
                {openHistory === note.topic ? "Hide history" : "History"}
              </Button>
            ) : null}
          </header>
          <Markdown content={note.body} className="mt-2 text-sm" />
          {openHistory === note.topic ? (
            <div className="mt-3 space-y-3 border-t border-border pt-3">
              {note.history.map((h) => (
                <div key={h.revision}>
                  <p className="text-xs text-muted-foreground">
                    rev {h.revision} · {relativeTime(h.writtenAt)}
                  </p>
                  <Markdown content={h.body} className="mt-1 text-xs opacity-80" />
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- staging

function StagingView() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { data, error } = useLive(() => rpc.call("staging", { limit: 50 }), [rpc]);
  if (data === null) return error === null ? <EmptyState>Loading staging log…</EmptyState> : <ErrorLine error={error} />;
  if (data.entries.length === 0) return <EmptyState>No staging integrations logged yet.</EmptyState>;
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
      {data.entries.map((entry: StagingEntry) => (
        <li key={entry.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm">
          <span className="font-medium">{entry.service}</span>
          <span className="truncate font-mono text-xs">{entry.branch}</span>
          <span className="text-xs text-muted-foreground">{entry.workstream}</span>
          <span className="ml-auto text-xs text-muted-foreground">{relativeTime(entry.at)}</span>
          <button
            type="button"
            className="w-full text-left text-xs text-muted-foreground hover:underline"
            onClick={() => navigate.toThread(entry.workerThreadId)}
          >
            {entry.purpose}
          </button>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------- new workstream

function NewWorkstreamDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [projects, setProjects] = useState<{ id: string; name: string; kind: string }[]>([]);
  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState("");
  const [links, setLinks] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    rpc.call("projects", null).then((result) => {
      setProjects(result.projects);
      setProjectId((current) => current || (result.projects.find((p) => p.kind === "standard") ?? result.projects[0])?.id || "");
    }, (cause: unknown) => setError(String(cause)));
  }, [open, rpc]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || name.trim() === "" || projectId === "") return;
    setPending(true);
    setError(null);
    try {
      const result = await rpc.call("workstream_create", {
        name: name.trim(),
        projectId,
        links: links.split("\n").map((l) => l.trim()).filter(Boolean),
      });
      onOpenChange(false);
      setName("");
      setLinks("");
      navigate.toThread(result.ariadneThreadId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>New workstream</DialogTitle>
            <DialogDescription>Creates a pinned Ariadne thread you can hand tickets to.</DialogDescription>
          </DialogHeader>
          <label className="block space-y-1 text-sm">
            <span className="font-medium">Name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. my-feature" autoFocus />
          </label>
          <label className="block space-y-1 text-sm">
            <span className="font-medium">Project</span>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <span className="text-xs text-muted-foreground">Workers get their own worktree of this repo.</span>
          </label>
          <label className="block space-y-1 text-sm">
            <span className="font-medium">Links (optional, one per line)</span>
            <textarea
              value={links}
              onChange={(e) => setLinks(e.target.value)}
              rows={3}
              placeholder="Jira epic, RFC, planning doc…"
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
            />
          </label>
          <ErrorLine error={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || name.trim() === "" || projectId === ""}>
              {pending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------- delete workstream

function DeleteWorkstreamDialog({ name, onClose, onDeleted }: { name: string | null; onClose: () => void; onDeleted?: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [preview, setPreview] = useState<DeletionPreview | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setPreview(null);
    setError(null);
    if (name === null) return;
    rpc.call("workstream_delete_preview", { name }).then(setPreview, (cause: unknown) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [name, rpc]);

  const confirm = async () => {
    if (name === null) return;
    setPending(true);
    setError(null);
    try {
      await rpc.call("workstream_delete", { name });
      onClose();
      onDeleted?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={name !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {name}?</DialogTitle>
          <DialogDescription>This cannot be undone.</DialogDescription>
        </DialogHeader>
        {preview === null ? (
          error === null ? <p className="text-sm text-muted-foreground">Checking workers for unsaved work…</p> : null
        ) : (
          <>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              <li>
                Archives {preview.liveWorkers} live worker {preview.liveWorkers === 1 ? "thread" : "threads"}. BB removes their
                worktrees about five minutes later. Branches with unpushed commits are kept.
              </li>
              <li>Deletes the Ariadne thread and its worker threads, or archives it if BB refuses.</li>
              <li>
                Removes {preview.tasks} {preview.tasks === 1 ? "task" : "tasks"}, {preview.notes}{" "}
                {preview.notes === 1 ? "note" : "notes"} and the audit trail. The staging log is kept.
              </li>
            </ul>
            {preview.risks.length === 0 ? null : (
              <div role="alert" className="space-y-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {preview.risks.map((r) => (
                  <p key={r.taskId} className="whitespace-pre-wrap">
                    Work at risk in {r.title}: {r.risk}
                  </p>
                ))}
              </div>
            )}
          </>
        )}
        <ErrorLine error={error} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={pending || preview === null} onClick={() => void confirm()}>
            {pending ? "Deleting…" : "Delete workstream"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ pages

function Counts({ ws }: { ws: Workstream }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      <Pill className={STATUS_STYLE.running}>{ws.counts.running} running</Pill>
      {ws.counts.blocked > 0 ? <Pill className={STATUS_STYLE.blocked}>{ws.counts.blocked} blocked</Pill> : null}
      {ws.counts.inReview > 0 ? <Pill className={STATUS_STYLE["in-review"]}>{ws.counts.inReview} in review</Pill> : null}
    </span>
  );
}

function WorkstreamList() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { data, error } = useLive(() => rpc.call("overview", null), [rpc]);
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const workstreams = data?.workstreams.filter((w) => showArchived || !w.archived) ?? null;
  const archivedCount = data?.workstreams.filter((w) => w.archived).length ?? 0;

  return (
    <>
      <div className="flex items-center gap-2">
        <p className="flex-1 text-sm text-muted-foreground">
          One Ariadne per workstream. Hand it tickets in its thread; it runs the workers.
        </p>
        <Button onClick={() => setCreating(true)}>
          <Icon name="Plus" className="size-4" />
          New workstream
        </Button>
      </div>
      <ErrorLine error={error} />
      <div className="mt-4">
        {workstreams === null ? (
          <EmptyState>Loading…</EmptyState>
        ) : workstreams.length === 0 ? (
          <EmptyState>No workstreams yet.</EmptyState>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {workstreams.map((ws) => (
              <li key={ws.name} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: ws.name })}
                >
                  <span className="font-medium hover:underline">{ws.name}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {ws.projectName ?? ws.projectId}
                    {ws.archived ? " · archived" : ""}
                  </span>
                </button>
                <Counts ws={ws} />
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-muted-foreground hover:text-destructive"
                  aria-label={`Delete ${ws.name}`}
                  onClick={() => setDeleting(ws.name)}
                >
                  <Icon name="Trash2" className="size-4" />
                </Button>
                <Button variant="outline" size="sm" onClick={() => navigate.toThread(ws.ariadneThreadId)}>
                  Open Ariadne
                </Button>
              </li>
            ))}
          </ul>
        )}
        {archivedCount > 0 ? (
          <Button variant="link" size="sm" className="mt-1 px-0" onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? "Hide" : "Show"} {archivedCount} archived
          </Button>
        ) : null}
      </div>
      <NewWorkstreamDialog open={creating} onOpenChange={setCreating} />
      <DeleteWorkstreamDialog name={deleting} onClose={() => setDeleting(null)} />
    </>
  );
}

type Tab = "board" | "notes" | "staging";

function WorkstreamDetail({ name }: { name: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { data, error } = useLive(() => rpc.call("overview", null), [rpc]);
  const [tab, setTab] = useState<Tab>("board");
  const [archiving, setArchiving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const ws = data?.workstreams.find((w) => w.name === name) ?? null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="icon" aria-label="All workstreams" onClick={() => navigate.toPluginPanel(PANEL_PATH)}>
          <Icon name="ArrowLeft" className="size-4" />
        </Button>
        <h2 className="text-base font-semibold">{name}</h2>
        {ws === null ? null : <span className="text-xs text-muted-foreground">{ws.projectName ?? ws.projectId}</span>}
        <span className="flex-1" />
        {ws === null ? null : (
          <>
            {ws.archived ? null : (
              <Button variant="outline" size="sm" onClick={() => setArchiving(true)}>
                Archive
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-muted-foreground hover:text-destructive"
              aria-label={`Delete ${name}`}
              onClick={() => setDeleting(true)}
            >
              <Icon name="Trash2" className="size-4" />
            </Button>
            <Button size="sm" onClick={() => navigate.toThread(ws.ariadneThreadId)}>
              Open Ariadne
            </Button>
          </>
        )}
      </div>
      {ws !== null && ws.links.length > 0 ? (
        <p className="mt-2 flex flex-wrap gap-3 text-xs">
          {ws.links.map((link) => (
            <UrlLink key={link} href={link} className="underline-offset-4 hover:underline">
              {link.replace(/^https?:\/\//, "").slice(0, 60)}
            </UrlLink>
          ))}
        </p>
      ) : null}
      <ErrorLine error={error} />
      {data !== null && ws === null ? (
        <div className="mt-4">
          <EmptyState>No workstream named “{name}”.</EmptyState>
        </div>
      ) : (
        <>
          <div role="tablist" className="mt-4 flex gap-1 border-b border-border">
            {(["board", "notes", "staging"] as const).map((t) => (
              <button
                key={t}
                role="tab"
                type="button"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={cn(
                  "-mb-px border-b-2 px-3 py-1.5 text-sm capitalize",
                  tab === t ? "border-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="mt-4">
            {tab === "board" ? <BoardTable workstream={name} /> : tab === "notes" ? <NotesView workstream={name} /> : <StagingView />}
          </div>
        </>
      )}
      <Dialog open={archiving} onOpenChange={setArchiving}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive {name}?</DialogTitle>
            <DialogDescription>
              Archives the Ariadne thread and its workers. Notes and the board stay readable here.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setArchiving(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setArchiving(false);
                void rpc.call("workstream_archive", { name });
              }}
            >
              Archive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DeleteWorkstreamDialog
        name={deleting ? name : null}
        onClose={() => setDeleting(false)}
        onDeleted={() => navigate.toPluginPanel(PANEL_PATH)}
      />
    </>
  );
}

function AriadnePage({ subPath }: { subPath: string }) {
  const name = workstreamFromSubPath(subPath);
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl px-4 pb-4 pt-3 md:px-5 md:pt-4">
        {name === null ? <WorkstreamList /> : <WorkstreamDetail name={name} />}
      </div>
    </div>
  );
}

function ThreadBoardPanel({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { data, error } = useLive(() => rpc.call("thread_context", { threadId }), [rpc, threadId]);
  const overview = useLive(() => rpc.call("overview", null), [rpc]);
  if (data === null) return <div className="p-3">{error === null ? <EmptyState>Loading…</EmptyState> : <ErrorLine error={error} />}</div>;
  if (data.role === "none" || data.workstream === null) {
    return (
      <div className="p-3">
        <EmptyState>This thread is not part of a Ariadne workstream.</EmptyState>
      </div>
    );
  }
  const ws = overview.data?.workstreams.find((w) => w.name === data.workstream) ?? null;
  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="flex-1 text-sm font-semibold">{data.workstream}</h3>
        {data.role === "worker" && ws !== null ? (
          <Button variant="outline" size="sm" onClick={() => navigate.toThread(ws.ariadneThreadId)}>
            Open Ariadne
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: data.workstream! })}
        >
          Full page
        </Button>
      </div>
      <BoardTable workstream={data.workstream} compact />
    </div>
  );
}

function HomeSection() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { data } = useLive(() => rpc.call("overview", null), [rpc]);
  const active = data?.workstreams.filter((w) => !w.archived) ?? [];
  if (active.length === 0) return null;
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
      {active.map((ws) => (
        <li key={ws.name} className="flex items-center gap-3 px-3 py-2 text-sm">
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left font-medium hover:underline"
            onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: ws.name })}
          >
            {ws.name}
          </button>
          <Counts ws={ws} />
          <Button variant="ghost" size="sm" onClick={() => navigate.toThread(ws.ariadneThreadId)}>
            Open Ariadne
          </Button>
        </li>
      ))}
    </ul>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "ariadne",
    title: "Ariadne",
    icon: "ariadne/yarn",
    path: PANEL_PATH,
    component: AriadnePage,
  });
  app.slots.threadPanelAction({
    id: "board",
    title: "Ariadne board",
    component: ThreadBoardPanel,
    run: ({ openPanel }) => {
      openPanel({ title: "Ariadne board" });
    },
  });
  app.slots.homepageSection({
    id: "workstreams",
    title: "Ariadne workstreams",
    component: HomeSection,
  });
});
