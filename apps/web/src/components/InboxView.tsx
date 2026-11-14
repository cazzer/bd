// The inbox (inbox.ts in core; server/routers/inbox.ts): everything waiting
// on the person, in one place (unify-review-queues). A list on the left, the
// selected item on the right.
//
// Tabs:
//   Needs me   — pending inbox items and the open board reviews of every
//                registered project (the shell's live review queue), merged
//                by priority then age (lib/inboxRows.ts), with a source
//                filter held in the address (`?source=`).
//   Undigested — items whose agent did not declare reading their primary
//                link; held out of Needs me (not counted there) until an
//                ingest pass digests them, or the person releases one.
//   With agent — being revised, carried out, or worked in a session.
//   Closed     — done or dismissed.
//
// Every decision goes through the same card (DecisionCard.tsx): an inbox
// item's question, options, on-accept steps, and its content as evidence,
// decided through `inboxDecision` (with Dismiss); a review through the board's
// own panel (ReviewItemPanel.tsx), decided through `reviewDecision`, which
// notifies the requesting agent as the drawer does. This view only reads and
// records; nothing here calls a model.
//
// Keys (outside a text field): j / k move, a accepts (the recommended option
// on a card), d dismisses, c focuses the message box, o opens the item in an
// interactive Claude session. Ctrl/Cmd+Enter accepts and Ctrl/Cmd+Shift+Enter
// requests changes, as in the board's run.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { filterBySource, groupByWork, hangarOriginLabel, needsMeRows, REVIEW_SOURCE, sourcesOf, type NeedsMeRow, type WorkGroupSlot } from "../lib/inboxRows.js";
import { navigate } from "../lib/navigate.js";
import { CARD_MOVED_TEXT, cardActions, chosenOption, describeChosen, isCardMovedRefusal, type CardOption } from "../lib/reviewCard.js";
import { decisionBlocked } from "../lib/reviewDrawer.js";
import { trpc } from "../trpc.js";
import { cardShortcut, DecisionCardBody, DecisionFooter, primaryDecision, type CardOutcome, type DecisionCardData, type Refusal } from "./DecisionCard.js";
import { EvidenceView } from "./EvidenceView.js";
import { ReviewItemPanel } from "./ReviewItemPanel.js";
import { HeaderSearch } from "./HeaderSearch.js";
import { ReviewQueuePill, storeDraft, useReviewQueue, useShellDrawer } from "./ReviewQueue.js";
import { SessionLinks, type SessionLinkResult } from "./SessionLinks.js";

type InboxResult = Awaited<ReturnType<typeof trpc.inbox.query>>;
type Item = InboxResult["items"][number];
type Review = ReturnType<typeof useReviewQueue>["reviews"][number];
type Row = NeedsMeRow<Item, Review>;
type Tab = "mine" | "undigested" | "agent" | "closed";
type Decision = "accept" | "changes" | "dismiss";

const TABS: { key: Tab; label: string; statuses: Item["status"][] }[] = [
  { key: "mine", label: "Needs me", statuses: ["pending"] },
  { key: "undigested", label: "Undigested", statuses: ["undigested"] },
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
  [REVIEW_SOURCE]: "Reviews",
};

const STATUS_LABEL: Record<Item["status"], string> = {
  pending: "needs you",
  changes: "agent revising",
  accepted: "agent executing",
  session: "in your session",
  undigested: "not yet read by its agent",
  dismissed: "dismissed",
  done: "done",
};

const FEEDBACK_LABEL: Record<Item["feedback"][number]["decision"], string> = {
  accept: "Accepted",
  changes: "Sent to agent",
  dismiss: "Dismissed",
  session: "Opened in a session",
  release: "Released to Needs me unread",
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

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** An inbox item as a card; null when it carries none (it shows as before: title, content). */
function cardOf(item: Item): DecisionCardData | null {
  if (item.question === null && item.options.length === 0) return null;
  return { question: item.question ?? item.title, options: item.options, recommend: item.recommend, onAccept: item.onAccept };
}

/** What the detail pane shows: a review by `<project>/<bead>`, or an inbox item by id. */
interface Shown {
  kind: "inbox" | "review";
  key: string;
}

export function InboxView({ item: selectedKey, source }: { item: string | null; source: string | null }) {
  const [tab, setTab] = useState<Tab>("mine");
  const [data, setData] = useState<InboxResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const generation = useRef(0);
  const queue = useReviewQueue();

  const load = useCallback(async () => {
    const mine = ++generation.current;
    try {
      // Batches are listed by their own status; their candidates come along
      // whatever theirs is, so a batch always shows every candidate.
      const result = await trpc.inbox.query({ statuses: tab === "closed" ? ["done", "dismissed"] : ["pending", "changes", "accepted", "session", "undigested", "done", "dismissed"] });
      if (mine !== generation.current) return;
      setData(result);
      setError(null);
      setNow(Date.now());
    } catch (err) {
      if (mine !== generation.current) return;
      setError(messageOf(err));
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

  const needsMe = useMemo(() => needsMeRows(all, queue.reviews), [all, queue.reviews]);
  const sources = useMemo(() => sourcesOf(needsMe), [needsMe]);
  const activeSource = tab === "mine" ? source : null;

  // The rows of the tab: Needs me merged and filtered; the others, inbox items by status.
  // Needs me is grouped by work context after the source filter (inbox-follow-through, design.md decision 9).
  const { rows, workSlots } = useMemo((): { rows: Row[]; workSlots: Map<string, WorkGroupSlot> } => {
    if (tab === "mine") {
      const grouped = groupByWork(filterBySource(needsMe, activeSource));
      return { rows: grouped.rows, workSlots: grouped.slots };
    }
    const statuses = TABS.find((t) => t.key === tab)!.statuses;
    const tabRows = all
      .filter((i) => i.parentId === null && statuses.includes(i.status))
      .map((item): Row => ({ kind: "inbox", key: item.id, priority: item.priority, at: item.receivedAt, source: item.source, item }));
    return { rows: tabRows, workSlots: new Map() };
  }, [tab, needsMe, activeSource, all]);

  const counts = useMemo(() => {
    const c: Record<Tab, number> = { mine: needsMe.length, undigested: 0, agent: 0, closed: 0 };
    for (const i of all) {
      if (i.parentId !== null) continue;
      for (const t of TABS) if (t.key !== "mine" && t.statuses.includes(i.status)) c[t.key] += 1;
    }
    return c;
  }, [all, needsMe]);

  // What the address names: a review (`<project>/<bead>`), an inbox item (a candidate shows inside its batch), else the first row.
  const shown: Shown | null = useMemo(() => {
    if (selectedKey !== null) {
      if (selectedKey.includes("/")) return { kind: "review", key: selectedKey };
      if (byId.has(selectedKey)) return { kind: "inbox", key: selectedKey };
    }
    const first = rows[0];
    return first === undefined ? null : { kind: first.kind, key: first.key };
  }, [selectedKey, byId, rows]);
  const selectedItem = shown?.kind === "inbox" ? (byId.get(shown.key) ?? null) : null;
  const selectedReview = shown?.kind === "review" ? (queue.reviews.find((r) => `${r.project}/${r.externalId}` === shown.key) ?? null) : null;
  const selectedRowKey = selectedItem !== null ? (selectedItem.parentId ?? selectedItem.id) : (shown?.key ?? null);

  // An address naming an inbox item in another tab (a link to a held item, a
  // decision moving the item on) brings that tab up, so the list and the
  // detail agree. A candidate goes by its batch.
  const addressed = selectedKey !== null ? (byId.get(selectedKey) ?? null) : null;
  const addressedStatus = addressed === null ? null : ((addressed.parentId !== null ? byId.get(addressed.parentId) : undefined) ?? addressed).status;
  useEffect(() => {
    if (addressedStatus === null) return;
    const home = TABS.find((t) => t.statuses.includes(addressedStatus))?.key;
    if (home !== undefined) setTab((current) => (TABS.find((t) => t.key === current)!.statuses.includes(addressedStatus) ? current : home));
  }, [selectedKey, addressedStatus]);

  const go = useCallback((item: string | null, nextSource: string | null = source) => navigate({ view: "inbox", item, source: nextSource }, "replace"), [source]);

  const move = useCallback(
    (delta: number) => {
      if (rows.length === 0) return;
      const index = rows.findIndex((r) => r.key === selectedRowKey);
      const next = rows[Math.min(rows.length - 1, Math.max(0, index + delta))];
      if (next) go(next.key);
    },
    [rows, selectedRowKey, go],
  );

  /** After a decision on the row at `key`: the next row, the way a mail client moves on. */
  const moveOnFrom = useCallback(
    (key: string) => {
      const index = rows.findIndex((r) => r.key === key);
      if (index === -1) return;
      const next = rows[index + 1] ?? rows[index - 1] ?? null;
      go(next?.key ?? null);
    },
    [rows, go],
  );

  const decide = useCallback(
    async (item: Item, decision: Decision, message = "", option?: string) => {
      await trpc.inboxDecision.mutate({ id: item.id, decision, message, ...(option === undefined ? {} : { option }) });
      if (item.parentId === null) moveOnFrom(item.id);
      await load();
    },
    [moveOnFrom, load],
  );

  const release = useCallback(
    async (item: Item) => {
      await trpc.inboxRelease.mutate({ id: item.id });
      await load();
    },
    [load],
  );

  const openSession = useCallback(
    async (item: Item): Promise<SessionLinkResult> => {
      const r = await trpc.inboxOpenSession.mutate({ id: item.id });
      await load();
      return { ok: true, tab: r.tab };
    },
    [load],
  );

  const message = useRef<HTMLTextAreaElement | null>(null);
  const keyed = useRef<{ accept: () => void } | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || isTextField(e.target)) return;
      if (e.key === "j") move(1);
      else if (e.key === "k") move(-1);
      else if (e.key === "c") {
        e.preventDefault();
        message.current?.focus();
      } else if (selectedItem === null) {
        return;
      } else if (e.key === "o" && ["pending", "changes", "session", "undigested"].includes(selectedItem.status)) {
        void openSession(selectedItem).catch(() => {});
      } else if (e.key === "a" && selectedItem.status === "pending") {
        keyed.current?.accept();
      } else if (e.key === "d" && ["pending", "undigested"].includes(selectedItem.status)) {
        // The note box belongs to the selected item's detail; a typed note is kept as the dismiss reason.
        void decide(selectedItem, "dismiss", message.current?.value ?? "");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move, decide, selectedItem, openSession]);

  function pickTab(next: Tab) {
    setTab(next);
    go(null, next === "mine" ? source : null);
  }

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
                onClick={() => pickTab(t.key)}
                aria-pressed={tab === t.key}
                className={`rounded-lg px-3 py-1 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-accent ${tab === t.key ? "bg-surface-strong text-fg" : "text-fg-muted hover:text-fg"}`}
              >
                {t.label} <span className="ml-1 tabular-nums text-fg-muted">{counts[t.key]}</span>
              </button>
            ))}
          </nav>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <p className="hidden text-xs text-fg-muted lg:block">
            <kbd className="rounded border border-hairline px-1">j</kbd>/<kbd className="rounded border border-hairline px-1">k</kbd> move ·{" "}
            <kbd className="rounded border border-hairline px-1">a</kbd> accept · <kbd className="rounded border border-hairline px-1">c</kbd> message ·{" "}
            <kbd className="rounded border border-hairline px-1">d</kbd> dismiss · <kbd className="rounded border border-hairline px-1">o</kbd> open session
          </p>
          <HeaderSearch />
          <ReviewQueuePill />
        </div>
      </header>

      {error !== null && (
        <p role="alert" className="mx-4 mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div className="flex max-h-[40dvh] shrink-0 flex-col border-b border-hairline md:max-h-none md:w-[380px] md:border-b-0 md:border-r">
          {tab === "mine" && sources.length > 1 && (
            <div role="group" aria-label="Filter by source" className="flex flex-wrap gap-1 border-b border-hairline px-3 py-2">
              {[null, ...sources].map((s) => (
                <button
                  key={s ?? "all"}
                  type="button"
                  onClick={() => go(null, s)}
                  aria-pressed={activeSource === s}
                  className={`rounded-full border px-2.5 py-0.5 text-[11px] focus:outline-none focus:ring-2 focus:ring-accent ${activeSource === s ? "border-accent/60 bg-accent/15 text-fg" : "border-hairline text-fg-muted hover:text-fg"}`}
                >
                  {s === null ? "All" : (SOURCE_LABEL[s] ?? s)} <span className="tabular-nums">{s === null ? needsMe.length : needsMe.filter((r) => r.source === s).length}</span>
                </button>
              ))}
            </div>
          )}
          <ul aria-label="Inbox items" className="min-h-0 flex-1 overflow-y-auto">
            {data === null && <li className="p-4 text-sm text-fg-muted">Loading…</li>}
            {data !== null && rows.length === 0 && (
              <li className="p-4 text-sm text-fg-muted">
                {tab === "mine" ? "Nothing needs you right now." : tab === "undigested" ? "Nothing held: every item's agent read what it was about." : "Nothing here."}
              </li>
            )}
            {rows.map((r) => {
              const slot = workSlots.get(r.key);
              return (
              <li key={r.key} className={slot !== undefined ? "border-l-2 border-accent/30" : undefined}>
                {slot?.first === true && (
                  <p className="px-4 pt-3 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
                    {slot.title} · {slot.count}
                  </p>
                )}
                <RowButton row={r} active={r.key === selectedRowKey} now={now} candidates={r.kind === "inbox" ? (childrenOf.get(r.item.id)?.length ?? 0) : 0} onPick={() => go(r.key)} />
              </li>
              );
            })}
          </ul>
        </div>

        {selectedReview !== null ? (
          <section aria-label="Selected review" className="flex min-h-0 flex-1 flex-col">
            <ReviewPane key={`${selectedReview.project}/${selectedReview.externalId}`} review={selectedReview} queueLoaded={queue.loaded} queueVersion={queue.version} onWritten={() => moveOnFrom(`${selectedReview.project}/${selectedReview.externalId}`)} />
          </section>
        ) : (
          <section aria-label="Selected item" className="min-h-0 flex-1 overflow-y-auto">
            {selectedItem === null ? (
              <p className="p-6 text-sm text-fg-muted">{shown?.kind === "review" ? "That review was decided or closed." : "Pick an item."}</p>
            ) : (
              <InboxDetail
                key={selectedItem.id}
                item={selectedItem}
                parent={selectedItem.parentId !== null ? (byId.get(selectedItem.parentId) ?? null) : null}
                candidates={childrenOf.get(selectedItem.id) ?? []}
                now={now}
                messageRef={message}
                keyed={keyed}
                onDecide={decide}
                onRelease={release}
                onSelect={(id) => go(id)}
                onOpenSession={openSession}
                onReload={load}
              />
            )}
          </section>
        )}
      </div>
    </main>
  );
}

function RowButton({ row, active, now, candidates, onPick }: { row: Row; active: boolean; now: number; candidates: number; onPick: () => void }) {
  const title = row.kind === "inbox" ? row.item.title : row.review.title.replace(/^Review:\s*/, "");
  const line = row.kind === "inbox" ? `${row.item.from !== null ? `${row.item.from} · ` : ""}${row.item.question ?? (row.item.action !== "none" ? `proposes: ${row.item.action.replaceAll("_", " ")}` : STATUS_LABEL[row.item.status])}` : row.review.summaryLine;
  return (
    <button
      type="button"
      onClick={onPick}
      aria-current={active ? "true" : undefined}
      className={`block w-full border-l-2 px-4 py-3 text-left focus:outline-none focus:ring-2 focus:ring-inset focus:ring-accent ${active ? "border-accent bg-surface-strong" : "border-transparent hover:bg-surface"}`}
    >
      <span className="flex items-center gap-2 text-[11px] text-fg-muted">
        {row.kind === "review" ? (
          <>
            <span className="rounded-full border border-accent/60 bg-accent/15 px-2 py-0.5 text-fg">review</span>
            <span className="rounded-full border border-hairline px-2 py-0.5">{row.review.project}</span>
          </>
        ) : (
          <>
            <span className="rounded-full border border-hairline px-2 py-0.5">{SOURCE_LABEL[row.item.source] ?? row.item.source}</span>
            {hangarOriginLabel(row.item) !== null && <span className="rounded-full border border-hairline px-2 py-0.5">{hangarOriginLabel(row.item)}</span>}
          </>
        )}
        {row.priority <= 1 && row.kind === "inbox" && <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-red-300">P{row.priority}</span>}
        {row.kind === "inbox" && row.item.options.length > 0 && <span>{row.item.options.length} options</span>}
        {candidates > 0 && <span>{candidates} candidates</span>}
        <span className="ml-auto">{ago(row.at, now)}</span>
      </span>
      <span className="mt-1 block truncate text-sm font-medium text-fg">{title || "(untitled)"}</span>
      <span className="mt-0.5 block truncate text-xs text-fg-muted">{line}</span>
    </button>
  );
}

/** A board review in the detail pane: the board's own panel, deciding through `reviewDecision` as the drawer does. */
function ReviewPane({ review, queueLoaded, queueVersion, onWritten }: { review: Review; queueLoaded: boolean; queueVersion: number; onWritten: () => void }) {
  const { drafts } = useShellDrawer();
  const titleId = useId();
  return (
    <ReviewItemPanel
      project={review.project}
      item={review.externalId}
      boardLoaded={queueLoaded}
      boardVersion={queueVersion}
      initialDraft={drafts.get(review.externalId) ?? ""}
      onDraftChange={(draft) => storeDraft(drafts, review.externalId, draft)}
      onDecided={() => {}}
      onProjectConfirmed={() => {}}
      onEscape={() => {}}
      titleId={titleId}
      compactHeader
      decisions={{ acceptLabel: "Accept", changesLabel: "Request changes", shortcuts: true, onWritten: () => onWritten() }}
    />
  );
}

interface InboxDetailProps {
  item: Item;
  parent: Item | null;
  candidates: Item[];
  now: number;
  messageRef: React.RefObject<HTMLTextAreaElement | null>;
  /** Where the view's `a` key reaches this item's accept. */
  keyed: React.RefObject<{ accept: () => void } | null>;
  onDecide: (item: Item, decision: Decision, message?: string, option?: string) => Promise<void>;
  onRelease: (item: Item) => Promise<void>;
  onSelect: (id: string) => void;
  onOpenSession: (item: Item) => Promise<SessionLinkResult>;
  onReload: () => Promise<void>;
}

function InboxDetail({ item, parent, candidates, now, messageRef, keyed, onDecide, onRelease, onSelect, onOpenSession, onReload }: InboxDetailProps) {
  const [message, setMessageState] = useState("");
  const [pending, setPending] = useState<"accept" | "changes" | null>(null);
  const [pendingOption, setPendingOption] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [needsMessage, setNeedsMessage] = useState(false);
  const [outcome, setOutcome] = useState<CardOutcome | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [focusedOption, setFocusedOption] = useState<string | null>(null);
  const optionPrefix = useId();
  const optionDescId = (id: string) => `${optionPrefix}-option-${id}`;

  const card = cardOf(item);
  const actions = card === null ? null : cardActions(card);
  const open = item.status === "pending";

  function setMessage(next: string) {
    setMessageState(next);
    if (next.trim() !== "") setNeedsMessage(false);
  }

  async function decide(decision: "accept" | "changes", option?: CardOption) {
    if (!open || decisionBlocked(decision, message, pending !== null || busy)) return;
    setPending(decision);
    setPendingOption(option?.id ?? null);
    setOutcome(null);
    setRefusal(null);
    try {
      await onDecide(item, decision, message, option?.id);
      const chosen = option !== undefined && card !== null ? ` ${describeChosen(chosenOption(card, option))}` : "";
      setOutcome({ tone: "ok", text: decision === "accept" ? `Accepted.${chosen}` : "Sent to the agent.", keepMessage: false, notified: null });
      setMessage("");
    } catch (err) {
      const text = messageOf(err);
      const moved = isCardMovedRefusal(text);
      setRefusal(moved ? { text: CARD_MOVED_TEXT, detail: text } : { text, detail: null });
      if (moved) await onReload();
    } finally {
      setPending(null);
      setPendingOption(null);
    }
  }

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setRefusal(null);
    try {
      await fn();
    } catch (err) {
      setRefusal({ text: messageOf(err), detail: null });
    } finally {
      setBusy(false);
    }
  }

  // The view's `a`: the recommended option on a card, plain Accept otherwise; nothing on a card that recommends none.
  useEffect(() => {
    keyed.current = {
      accept: () => {
        if (actions === null) void decide(primaryDecision(message, true));
        else if (actions.accept !== null) void decide("accept", actions.accept);
      },
    };
    return () => {
      keyed.current = null;
    };
  });

  function onKeyDown(e: React.KeyboardEvent<HTMLElement>) {
    if (!open || e.defaultPrevented) return;
    const shortcut = cardShortcut(e, card, message, { noteSendsToAgent: true });
    if (shortcut === null) return;
    e.preventDefault();
    if (e.repeat) return;
    if (shortcut.kind === "needs-message") {
      setNeedsMessage(true);
      messageRef.current?.focus();
    } else if (shortcut.kind === "changes") void decide("changes");
    else if (shortcut.kind === "accept") void decide("accept", shortcut.option);
  }

  const sessionLinks = (
    <SessionLinks
      canFocus={item.sessionTab !== null}
      focusLabel="Go to session"
      focus={async () => {
        await trpc.inboxFocusSession.mutate({ id: item.id });
        return { ok: true, tab: item.sessionTab ?? "" };
      }}
      open={() => onOpenSession(item)}
    />
  );

  const origin = hangarOriginLabel(item);
  const recipient =
    item.hangarSession !== null
      ? "Will be sent to the hangar session that filed it."
      : item.pane !== null
        ? `Will prompt the session that queued it (pane ${item.pane}).`
        : "Accepted items are carried out by the inbox watcher (or /inbox-execute).";
  const pendingIgnores = candidates.filter((c) => c.status === "pending" && (c.action === "ignore" || c.action === "none"));

  return (
    <article onKeyDown={onKeyDown} className="mx-auto flex min-h-full max-w-3xl flex-col gap-5 p-4 md:p-6">
      {parent !== null && (
        <button type="button" onClick={() => onSelect(parent.id)} className="self-start text-xs text-accent hover:underline">
          ← {parent.title}
        </button>
      )}
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-fg-muted">
          <span className="rounded-full border border-hairline px-2 py-0.5">{SOURCE_LABEL[item.source] ?? item.source}</span>
          {origin !== null && <span className="rounded-full border border-hairline px-2 py-0.5">{origin}</span>}
          <span className={`rounded-full border px-2 py-0.5 ${item.status === "undigested" ? "border-amber-400/50 bg-amber-400/10 text-amber-200" : "border-hairline"}`}>{STATUS_LABEL[item.status]}</span>
          {item.verdict !== null && <span className="rounded-full border border-hairline px-2 py-0.5">verdict: {item.verdict.replaceAll("_", " ")}</span>}
          <span>{ago(item.receivedAt, now)}</span>
          {item.from !== null && <span>from {item.from}</span>}
          {item.about !== null && <WorkContextChip itemId={item.id} work={item.about} onUnlinked={onReload} />}
        </div>
        <h2 className="text-lg font-semibold text-fg">{item.title || "(untitled)"}</h2>
        {item.action !== "none" && (
          <p className="text-sm text-fg-muted">
            Proposed action: <span className="font-medium text-fg">{item.action.replaceAll("_", " ")}</span>
          </p>
        )}
      </header>

      {item.revision !== null && item.status === "pending" && (
        <p role="note" className="rounded-xl border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-fg">
          <span className="font-medium">Revised on your note:</span> {item.revision}
        </p>
      )}
      {item.closeReason !== null && (item.status === "done" || item.status === "dismissed") && (
        <p role="note" className="rounded-xl border border-hairline bg-fg/[0.03] px-3 py-2 text-sm text-fg-muted">
          <span className="font-medium text-fg">Closed on your note:</span> {item.closeReason}
        </p>
      )}

      {item.status === "undigested" && (
        <section aria-label="Undigested" className="space-y-2 rounded-xl border border-amber-400/40 bg-amber-400/10 p-3 text-sm text-amber-100">
          <p>
            Its agent didn't declare reading {item.url !== null ? <a href={item.url} target="_blank" rel="noreferrer" className="underline">the linked artifact</a> : "the linked artifact"}, so it is held out of Needs me. The next inbox
            ingest pass reads it and puts it in front of you.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={() => void act(() => onRelease(item))} className="rounded-lg border border-amber-400/50 px-3 py-1 text-xs text-fg hover:bg-amber-400/20 disabled:opacity-60">
              Release to Needs me unread
            </button>
            <button type="button" disabled={busy} onClick={() => void act(() => onDecide(item, "dismiss", message))} className="rounded-lg px-3 py-1 text-xs text-fg-muted hover:text-fg disabled:opacity-60">
              Dismiss
            </button>
          </div>
        </section>
      )}

      <div className="space-y-5">
        {card !== null ? (
          <DecisionCardBody key={item.updatedAt} card={card} evidence={item.content} focusedOption={focusedOption} optionDescId={optionDescId} />
        ) : (
          item.content.trim() !== "" && (
            <div className="glass p-4 text-sm">
              {/* The review cards' read-only renderer: GFM tables, mermaid diagrams, and diffs in a draft render as such. */}
              <EvidenceView key={item.updatedAt} markdown={item.content} />
            </div>
          )
        )}
      </div>

      {candidates.length > 0 && (
        <section aria-label="Candidates" className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-fg">Candidates</h3>
            {pendingIgnores.length > 0 && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    for (const c of pendingIgnores) await onDecide(c, "dismiss");
                    // Nothing actionable left in the batch: the batch itself is settled too.
                    const remaining = candidates.filter((c) => c.status === "pending" && !pendingIgnores.includes(c));
                    if (remaining.length === 0 && item.status === "pending") await onDecide(item, "dismiss", "verdicts confirmed");
                  })
                }
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
                <span className={`w-20 shrink-0 text-[11px] font-medium uppercase ${c.action === "ignore" || c.action === "none" ? "text-fg-muted" : "text-accent"}`}>
                  {c.action === "ignore" || c.action === "none" ? "ignore" : "action"}
                </span>
                <button type="button" onClick={() => onSelect(c.id)} className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-sm text-fg">{c.title}</span>
                  <span className="block truncate text-xs text-fg-muted">
                    {c.verdict !== null ? c.verdict.replaceAll("_", " ") : c.action.replaceAll("_", " ")} · {STATUS_LABEL[c.status]}
                  </span>
                </button>
                {c.status === "pending" && c.options.length === 0 && (
                  <span className="flex shrink-0 gap-1">
                    <button type="button" disabled={busy} onClick={() => void act(() => onDecide(c, "accept"))} className="rounded-md bg-accent/20 px-2 py-1 text-xs text-fg hover:bg-accent/30 disabled:opacity-60">
                      Accept
                    </button>
                    <button type="button" disabled={busy} onClick={() => void act(() => onDecide(c, "dismiss"))} className="rounded-md border border-hairline px-2 py-1 text-xs text-fg-muted hover:text-fg disabled:opacity-60">
                      Dismiss
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {(item.links.length > 0 || item.url !== null || item.read.length > 0) && (
        <section aria-label="Sources" className="space-y-2">
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
          {item.read.length > 0 && (
            <p className="text-xs text-fg-muted">
              The agent read:{" "}
              {item.read.map((r, i) => (
                <span key={r.ref}>
                  {i > 0 && ", "}
                  <span className="break-all text-fg">{r.ref.replace(/^https?:\/\//, "")}</span>
                  {r.depth === "skimmed" && " (skimmed)"}
                </span>
              ))}
            </p>
          )}
        </section>
      )}

      {item.feedback.length > 0 && (
        <section aria-label="History" className="space-y-1">
          <h3 className="text-sm font-semibold text-fg">History</h3>
          <ol className="space-y-1 text-xs text-fg-muted">
            {item.feedback.map((f, i) => (
              <li key={i}>
                <span className="text-fg">
                  {FEEDBACK_LABEL[f.decision]}
                  {f.option !== undefined && ` option ${f.option}`}
                </span>{" "}
                · {ago(f.at, now)}
                {f.message !== "" && <span className="mt-0.5 block whitespace-pre-wrap text-fg">{f.message}</span>}
              </li>
            ))}
          </ol>
        </section>
      )}

      <div className="mt-auto">
        {open || outcome !== null || refusal !== null ? (
          <div className="sticky bottom-0 overflow-hidden rounded-xl border border-hairline">
            <DecisionFooter
              open={open}
              recipient={recipient}
              sessionLinks={sessionLinks}
              labels={{
                acceptLabel: "Accept",
                changesLabel: "Send to agent",
                noteSendsToAgent: true,
                shortcuts: true,
                extra: ({ busy: writing }) =>
                  open && (
                    <button type="button" disabled={writing || busy} onClick={() => void act(() => onDecide(item, "dismiss", message))} className="min-h-11 rounded-lg px-4 text-sm text-fg-muted hover:text-fg disabled:opacity-60 sm:min-h-10">
                      Dismiss
                    </button>
                  ),
              }}
              messageLabel="Note to the agent (with a note, it goes to the agent instead of being accepted)"
              actions={actions}
              message={message}
              setMessage={setMessage}
              messageRef={messageRef}
              needsMessage={needsMessage}
              pending={pending}
              pendingOption={pendingOption}
              onOptionFocus={setFocusedOption}
              optionDescId={optionDescId}
              outcome={outcome}
              refusal={refusal}
              decide={(d, option) => void decide(d, option)}
            />
          </div>
        ) : item.status === "session" || item.status === "changes" || item.status === "undigested" ? (
          <section aria-label="Session" className="space-y-2 text-xs text-fg-muted">
            {item.status !== "undigested" && (
              <div className="flex flex-wrap items-center gap-2">
                <span>
                  {item.status === "session"
                    ? "In an interactive session. It will send a draft back here for approval, or close the item when the work is done there."
                    : "With the agent. It closes it or does it on your note, and brings it back only if there is something new for you to see."}
                </span>
                <button type="button" disabled={busy} onClick={() => void act(() => onDecide(item, "dismiss", message))} className="rounded-lg px-3 py-1 hover:text-fg disabled:opacity-60">
                  Dismiss
                </button>
              </div>
            )}
            {sessionLinks}
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
      </div>
    </article>
  );
}

/** "About: <work>" with the person's "not this", which removes the item's `about` link (inbox-follow-through). */
function WorkContextChip({ itemId, work, onUnlinked }: { itemId: string; work: { id: string; title: string; project: string | null }; onUnlinked: () => void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-fg">
      <span title={work.project ?? undefined}>About: {work.title}</span>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setFailed(null);
          try {
            await trpc.inboxUnlinkWork.mutate({ id: itemId });
            await onUnlinked();
          } catch (err) {
            setFailed(messageOf(err));
          } finally {
            setBusy(false);
          }
        }}
        className="rounded-full px-1 text-fg-muted hover:text-fg disabled:opacity-60"
        aria-label={`Not about ${work.title}: unlink`}
      >
        not this
      </button>
      {failed !== null && <span role="alert" className="text-red-300">{failed}</span>}
    </span>
  );
}
