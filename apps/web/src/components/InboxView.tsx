// The inbox (inbox.ts in core; server/routers/inbox.ts): everything an agent
// has triaged out of the person's sources, waiting on a decision. A list on
// the left (batches carry their candidates), the selected item on the right:
// what happened, the proposed action rendered as markdown, every signal that
// folded into it, the decision history, and the decision bar.
//
// Deciding writes the decision and moves the item to the next turn — the
// executor session picks up accepted items, the agent revises items sent
// back with changes. This view only reads and records.
//
// Keys (outside a text field): j / k move, a accepts, d dismisses, c focuses
// the change request box, o opens the item in an interactive Claude session
// (a new herdr tab; the session re-queues its draft here for approval).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { navigate } from "../lib/navigate.js";
import { trpc } from "../trpc.js";
import { MarkdownEditor } from "./MarkdownEditor.js";
import { MarkdownRenderBoundary } from "./MarkdownRenderBoundary.js";
import { ReviewQueuePill } from "./ReviewQueue.js";

type InboxResult = Awaited<ReturnType<typeof trpc.inbox.query>>;
type Item = InboxResult["items"][number];
type Tab = "mine" | "agent" | "closed";

const TABS: { key: Tab; label: string; statuses: Item["status"][] }[] = [
  { key: "mine", label: "Needs me", statuses: ["pending"] },
  { key: "agent", label: "With agent", statuses: ["changes", "accepted", "session"] },
  { key: "closed", label: "Closed", statuses: ["done", "dismissed"] },
];

const POLL_MS = 15_000;

const SOURCE_LABEL: Record<string, string> = {
  gmail: "Email",
  asana: "Asana",
  slack: "Slack",
  notion: "Notion",
  gdocs: "Google Docs",
  github: "GitHub",
  fathom: "Fathom",
  session: "Claude session",
};

const STATUS_LABEL: Record<Item["status"], string> = {
  pending: "needs you",
  changes: "agent revising",
  accepted: "agent executing",
  session: "in your session",
  dismissed: "dismissed",
  done: "done",
};

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function isTextField(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

export function InboxView({ item: selectedId }: { item: string | null }) {
  const [tab, setTab] = useState<Tab>("mine");
  const [data, setData] = useState<InboxResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const generation = useRef(0);

  const statuses = TABS.find((t) => t.key === tab)!.statuses;

  const load = useCallback(async () => {
    const mine = ++generation.current;
    try {
      // Batches are listed by their own status; their candidates come along
      // whatever theirs is, so a batch always shows every candidate.
      const result = await trpc.inbox.query({ statuses: tab === "closed" ? ["done", "dismissed"] : ["pending", "changes", "accepted", "session", "done", "dismissed"] });
      if (mine !== generation.current) return;
      setData(result);
      setError(null);
      setNow(Date.now());
    } catch (err) {
      if (mine !== generation.current) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [tab]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const all = data?.items ?? [];
  const childrenOf = useMemo(() => {
    const map = new Map<string, Item[]>();
    for (const i of all) {
      if (i.parentId !== null) map.set(i.parentId, [...(map.get(i.parentId) ?? []), i]);
    }
    return map;
  }, [all]);
  const byId = useMemo(() => new Map(all.map((i) => [i.id, i])), [all]);

  // Top-level rows: items without a parent whose own status is in this tab.
  const rows = useMemo(() => all.filter((i) => i.parentId === null && statuses.includes(i.status)), [all, statuses]);
  const counts = useMemo(() => {
    const c: Record<Tab, number> = { mine: 0, agent: 0, closed: 0 };
    for (const i of all) {
      if (i.parentId !== null) continue;
      for (const t of TABS) if (t.statuses.includes(i.status)) c[t.key] += 1;
    }
    return c;
  }, [all]);

  const selected = (selectedId !== null ? byId.get(selectedId) : undefined) ?? rows[0] ?? null;

  const select = useCallback((id: string | null) => navigate({ view: "inbox", item: id }, "replace"), []);

  const move = useCallback(
    (delta: number) => {
      if (rows.length === 0) return;
      const index = selected === null ? -1 : rows.findIndex((r) => r.id === (selected.parentId ?? selected.id));
      const next = rows[Math.min(rows.length - 1, Math.max(0, index + delta))];
      if (next) select(next.id);
    },
    [rows, selected, select],
  );

  const decide = useCallback(
    async (item: Item, decision: "accept" | "changes" | "dismiss", message = "") => {
      const index = rows.findIndex((r) => r.id === item.id);
      await trpc.inboxDecision.mutate({ id: item.id, decision, message });
      // Move on to the next item in the list, the way a mail client does.
      if (item.parentId === null && index !== -1) {
        const next = rows[index + 1] ?? rows[index - 1] ?? null;
        select(next?.id ?? null);
      }
      await load();
    },
    [rows, select, load],
  );

  const [sessionError, setSessionError] = useState<string | null>(null);
  const openSession = useCallback(
    async (item: Item) => {
      setSessionError(null);
      try {
        await trpc.inboxOpenSession.mutate({ id: item.id });
        await load();
      } catch (err) {
        setSessionError(err instanceof Error ? err.message : String(err));
      }
    },
    [load],
  );
  const focusSession = useCallback(async (item: Item) => {
    setSessionError(null);
    try {
      await trpc.inboxFocusSession.mutate({ id: item.id });
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const changesBox = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || isTextField(e.target)) return;
      if (e.key === "j") move(1);
      else if (e.key === "k") move(-1);
      else if (e.key === "c") {
        e.preventDefault();
        changesBox.current?.focus();
      } else if (e.key === "o" && selected !== null && ["pending", "changes", "session"].includes(selected.status)) {
        void openSession(selected);
      } else if (selected !== null && selected.status === "pending" && (e.key === "a" || e.key === "d")) {
        void decide(selected, e.key === "a" ? "accept" : "dismiss");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move, decide, selected, openSession]);

  return (
    <main className="flex h-dvh w-screen flex-col overflow-hidden">
      <div aria-hidden="true" className="ambience pointer-events-none fixed inset-0 -z-10" />
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-4 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-semibold text-fg">Inbox</h1>
          <nav aria-label="Inbox tabs" className="flex gap-1">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                aria-pressed={tab === t.key}
                className={`rounded-lg px-3 py-1 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-accent ${tab === t.key ? "bg-surface-strong text-fg" : "text-fg-muted hover:text-fg"}`}
              >
                {t.label} <span className="ml-1 tabular-nums text-fg-muted">{counts[t.key]}</span>
              </button>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3">
        <p className="hidden text-xs text-fg-muted lg:block">
          <kbd className="rounded border border-hairline px-1">j</kbd>/<kbd className="rounded border border-hairline px-1">k</kbd> move ·{" "}
          <kbd className="rounded border border-hairline px-1">a</kbd> accept · <kbd className="rounded border border-hairline px-1">c</kbd> request changes ·{" "}
          <kbd className="rounded border border-hairline px-1">d</kbd> dismiss · <kbd className="rounded border border-hairline px-1">o</kbd> open session
        </p>
        <ReviewQueuePill />
        </div>
      </header>

      {sessionError !== null && (
        <p role="alert" className="mx-4 mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
          {sessionError}
        </p>
      )}
      {error !== null && (
        <p role="alert" className="mx-4 mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <ul aria-label="Inbox items" className="max-h-[40dvh] shrink-0 overflow-y-auto border-b border-hairline md:max-h-none md:w-[380px] md:border-b-0 md:border-r">
          {data === null && <li className="p-4 text-sm text-fg-muted">Loading…</li>}
          {data !== null && rows.length === 0 && <li className="p-4 text-sm text-fg-muted">{tab === "mine" ? "Nothing needs you right now." : "Nothing here."}</li>}
          {rows.map((r) => {
            const kids = childrenOf.get(r.id) ?? [];
            const active = selected !== null && (selected.id === r.id || selected.parentId === r.id);
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => select(r.id)}
                  aria-current={active ? "true" : undefined}
                  className={`block w-full border-l-2 px-4 py-3 text-left focus:outline-none focus:ring-2 focus:ring-inset focus:ring-accent ${active ? "border-accent bg-surface-strong" : "border-transparent hover:bg-surface"}`}
                >
                  <span className="flex items-center gap-2 text-[11px] text-fg-muted">
                    <span className="rounded-full border border-hairline px-2 py-0.5">{SOURCE_LABEL[r.source] ?? r.source}</span>
                    {r.priority <= 1 && <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-red-300">P{r.priority}</span>}
                    {kids.length > 0 && <span>{kids.length} candidates</span>}
                    <span className="ml-auto">{ago(r.receivedAt, now)}</span>
                  </span>
                  <span className="mt-1 block truncate text-sm font-medium text-fg">{r.title || "(untitled)"}</span>
                  <span className="mt-0.5 block truncate text-xs text-fg-muted">
                    {r.from !== null ? `${r.from} · ` : ""}
                    {r.action !== "none" ? `proposes: ${r.action.replaceAll("_", " ")}` : STATUS_LABEL[r.status]}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        <section aria-label="Selected item" className="min-h-0 flex-1 overflow-y-auto">
          {selected === null ? (
            <p className="p-6 text-sm text-fg-muted">Pick an item.</p>
          ) : (
            <Detail
              key={selected.id}
              item={selected}
              parent={selected.parentId !== null ? (byId.get(selected.parentId) ?? null) : null}
              candidates={childrenOf.get(selected.id) ?? []}
              now={now}
              changesBox={changesBox}
              onDecide={decide}
              onSelect={select}
              onOpenSession={openSession}
              onFocusSession={focusSession}
            />
          )}
        </section>
      </div>
    </main>
  );
}

interface DetailProps {
  item: Item;
  parent: Item | null;
  candidates: Item[];
  now: number;
  changesBox: React.RefObject<HTMLTextAreaElement | null>;
  onDecide: (item: Item, decision: "accept" | "changes" | "dismiss", message?: string) => Promise<void>;
  onSelect: (id: string) => void;
  onOpenSession: (item: Item) => Promise<void>;
  onFocusSession: (item: Item) => Promise<void>;
}

function Detail({ item, parent, candidates, now, changesBox, onDecide, onSelect, onOpenSession, onFocusSession }: DetailProps) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(decision: "accept" | "changes" | "dismiss", target: Item = item) {
    if (decision === "changes" && message.trim() === "") {
      setError("Say what needs to change.");
      changesBox.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onDecide(target, decision, target === item ? message : "");
      if (target === item) setMessage("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const pendingIgnores = candidates.filter((c) => c.status === "pending" && (c.action === "ignore" || c.action === "none"));

  return (
    <article className="mx-auto max-w-3xl space-y-5 p-4 md:p-6">
      {parent !== null && (
        <button type="button" onClick={() => onSelect(parent.id)} className="text-xs text-accent hover:underline">
          ← {parent.title}
        </button>
      )}
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-fg-muted">
          <span className="rounded-full border border-hairline px-2 py-0.5">{SOURCE_LABEL[item.source] ?? item.source}</span>
          <span className="rounded-full border border-hairline px-2 py-0.5">{STATUS_LABEL[item.status]}</span>
          {item.verdict !== null && <span className="rounded-full border border-hairline px-2 py-0.5">verdict: {item.verdict.replaceAll("_", " ")}</span>}
          <span>{ago(item.receivedAt, now)}</span>
          {item.from !== null && <span>from {item.from}</span>}
        </div>
        <h2 className="text-lg font-semibold text-fg">{item.title || "(untitled)"}</h2>
        {item.action !== "none" && (
          <p className="text-sm text-fg-muted">
            Proposed action: <span className="font-medium text-fg">{item.action.replaceAll("_", " ")}</span>
          </p>
        )}
      </header>

      {item.content.trim() !== "" && (
        <div className="glass p-4 text-sm">
          <MarkdownRenderBoundary rawContent={item.content}>
            <MarkdownEditor key={`${item.id}:${item.updatedAt}`} initialContent={item.content} editable={false} ariaLabel={`${item.title} details`} />
          </MarkdownRenderBoundary>
        </div>
      )}

      {candidates.length > 0 && (
        <section aria-label="Candidates" className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-fg">Candidates</h3>
            {pendingIgnores.length > 0 && (
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    for (const c of pendingIgnores) await onDecide(c, "dismiss");
                    // Nothing actionable left in the batch: the batch itself is settled too.
                    const remaining = candidates.filter((c) => c.status === "pending" && !pendingIgnores.includes(c));
                    if (remaining.length === 0 && item.status === "pending") await onDecide(item, "dismiss", "verdicts confirmed");
                  } finally {
                    setBusy(false);
                  }
                }}
                className="rounded-lg border border-hairline px-3 py-1 text-xs text-fg hover:bg-surface-strong disabled:opacity-60"
              >
                Agree with {pendingIgnores.length} ignore verdict{pendingIgnores.length === 1 ? "" : "s"}
                {candidates.every((c) => c.status !== "pending" || pendingIgnores.includes(c)) ? " and close" : ""}
              </button>
            )}
          </div>
          <ul className="divide-y divide-hairline rounded-xl border border-hairline">
            {candidates.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-3 py-2">
                <span
                  className={`w-20 shrink-0 text-[11px] font-medium uppercase ${c.action === "ignore" || c.action === "none" ? "text-fg-muted" : "text-accent"}`}
                >
                  {c.action === "ignore" || c.action === "none" ? "ignore" : "action"}
                </span>
                <button type="button" onClick={() => onSelect(c.id)} className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-sm text-fg">{c.title}</span>
                  <span className="block truncate text-xs text-fg-muted">
                    {c.verdict !== null ? c.verdict.replaceAll("_", " ") : c.action.replaceAll("_", " ")} · {STATUS_LABEL[c.status]}
                  </span>
                </button>
                {c.status === "pending" && (
                  <span className="flex shrink-0 gap-1">
                    <button type="button" disabled={busy} onClick={() => void run("accept", c)} className="rounded-md bg-accent/20 px-2 py-1 text-xs text-fg hover:bg-accent/30 disabled:opacity-60">
                      Accept
                    </button>
                    <button type="button" disabled={busy} onClick={() => void run("dismiss", c)} className="rounded-md border border-hairline px-2 py-1 text-xs text-fg-muted hover:text-fg disabled:opacity-60">
                      Dismiss
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {(item.links.length > 0 || item.url !== null) && (
        <section aria-label="Sources" className="space-y-1">
          <h3 className="text-sm font-semibold text-fg">Sources</h3>
          <ul className="flex flex-wrap gap-2">
            {item.url !== null && !item.links.some((l) => l.url === item.url) && (
              <li>
                <a href={item.url} target="_blank" rel="noreferrer" className="rounded-full border border-hairline px-3 py-1 text-xs text-accent hover:underline">
                  Open in {SOURCE_LABEL[item.source] ?? item.source}
                </a>
              </li>
            )}
            {item.links.map((l) => (
              <li key={l.url}>
                <a href={l.url} target="_blank" rel="noreferrer" className="rounded-full border border-hairline px-3 py-1 text-xs text-accent hover:underline">
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {item.feedback.length > 0 && (
        <section aria-label="History" className="space-y-1">
          <h3 className="text-sm font-semibold text-fg">History</h3>
          <ol className="space-y-1 text-xs text-fg-muted">
            {item.feedback.map((f, i) => (
              <li key={i}>
                <span className="text-fg">
                  {f.decision === "changes" ? "Changes requested" : f.decision === "accept" ? "Accepted" : f.decision === "session" ? "Opened in a session" : "Dismissed"}
                </span> · {ago(f.at, now)}
                {f.message !== "" && <span className="mt-0.5 block whitespace-pre-wrap text-fg">{f.message}</span>}
              </li>
            ))}
          </ol>
        </section>
      )}

      {item.status === "pending" ? (
        <section aria-label="Decision" className="glass sticky bottom-0 space-y-2 p-3">
          <textarea
            ref={changesBox}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={2}
            placeholder="What should change? (required for Request changes, optional note otherwise)"
            className="w-full resize-y rounded-lg border border-hairline bg-transparent px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={busy} onClick={() => void run("accept")} className="rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-ground hover:opacity-90 disabled:opacity-60">
              Accept
            </button>
            <button type="button" disabled={busy} onClick={() => void run("changes")} className="rounded-lg border border-hairline px-4 py-1.5 text-sm text-fg hover:bg-surface-strong disabled:opacity-60">
              Request changes
            </button>
            <button type="button" disabled={busy} onClick={() => void run("dismiss")} className="rounded-lg px-4 py-1.5 text-sm text-fg-muted hover:text-fg disabled:opacity-60">
              Dismiss
            </button>
            <span className="ml-auto flex gap-2">
              {item.sessionTab !== null && (
                <button type="button" onClick={() => void onFocusSession(item)} className="rounded-lg px-3 py-1.5 text-sm text-accent hover:underline">
                  Go to session
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await onOpenSession(item);
                  } finally {
                    setBusy(false);
                  }
                }}
                title="Open a new herdr tab with Claude working on this item (o)"
                className="rounded-lg border border-accent/50 px-4 py-1.5 text-sm text-fg hover:bg-surface-strong disabled:opacity-60"
              >
                Open session ↗
              </button>
            </span>
            {error !== null && (
              <span role="alert" className="text-xs text-red-300">
                {error}
              </span>
            )}
          </div>
        </section>
      ) : item.status === "session" || item.status === "changes" ? (
        <section aria-label="Session" className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
          <span>
            {item.status === "session"
              ? "In an interactive session. It will send a draft back here for approval, or close the item when the work is done there."
              : "Sent back. The agent will revise it and return it to you."}
          </span>
          {item.sessionTab !== null && (
            <button type="button" onClick={() => void onFocusSession(item)} className="rounded-lg border border-hairline px-3 py-1 text-fg hover:bg-surface-strong">
              Go to session
            </button>
          )}
          <button type="button" onClick={() => void onOpenSession(item)} className="rounded-lg border border-hairline px-3 py-1 text-fg hover:bg-surface-strong">
            {item.status === "session" ? "Open a new session" : "Open session ↗"}
          </button>
          <button type="button" onClick={() => void onDecide(item, "dismiss")} className="rounded-lg px-3 py-1 hover:text-fg">
            Dismiss
          </button>
        </section>
      ) : (
        <p className="text-xs text-fg-muted">
          {item.status === "accepted"
            ? item.sessionTab !== null
              ? "Accepted. The session that drafted it is carrying it out."
              : "Accepted. The inbox watcher (or /inbox-execute) will carry it out and mark it done."
            : "Closed."}
        </p>
      )}
    </article>
  );
}
