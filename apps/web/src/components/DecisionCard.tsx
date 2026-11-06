// One decision card, whatever queue it came from (unify-review-queues,
// design.md decision 3): the card body (question, options with the
// recommended one first, on-accept steps, evidence) and the decision footer
// (message box, "Accept <recommended>", "Choose <other>" with the fold,
// Request changes, the host's extra controls, the session links, and the
// outcome line). Neither part writes anything: the host passes `decide`
// and reports what happened through `outcome` / `refusal`. The board's
// review panel (ReviewItemPanel.tsx) and the inbox (InboxView.tsx) both
// render through it, each deciding through its own queue.
//
// `cardShortcut` is the one reading of Ctrl/Cmd+Enter both hosts share:
// on a card with options, the option whose button has focus, else the
// recommended one (nothing from the fold's toggle); plain Accept otherwise;
// with Shift, Request changes, which needs a message.

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cardActions, evidenceMarkdown, foldLabel, type CardActions, type CardLike, type CardOption } from "../lib/reviewCard.js";
import { decisionBlocked, type DecisionOutcome, type ReviewDecisionKind } from "../lib/reviewDrawer.js";
import { CardEvidence, CardOnAccept, CardOptions, CardQuestion, InlineText } from "./ReviewCardBody.js";

/** The footer's labels and the host's hooks into it. */
export interface FooterLabels {
  acceptLabel: string;
  changesLabel: string;
  /** Below `sm`; given both, the actions share one row there and the recipient line is left out. */
  acceptShort?: string;
  changesShort?: string;
  /** After a card's option actions ("Accept <label>", "Choose <label>"), shown muted: the run's "& next". */
  optionSuffix?: string;
  /** The host's own controls at the end of the decision row. */
  extra?: (state: { busy: boolean }) => ReactNode;
  /** Shown in place of the message box and the decisions, at the same height. */
  notice?: ReactNode;
  /** Ctrl/Cmd+Enter accepts, Ctrl/Cmd+Shift+Enter requests changes. */
  shortcuts?: boolean;
  /**
   * Where the shortcut hint is drawn instead of the footer (the run's
   * header, which has the width). Given, the footer has no recipient/hint
   * line: the recipient describes the message box (its tooltip and
   * accessible description) and the hint goes here (from `lg` up, as in the
   * footer). Null until the host's element mounts.
   */
  hintTarget?: HTMLElement | null;
}

export interface CardOutcome extends DecisionOutcome {
  notified: string | null;
}

export interface Refusal {
  text: string;
  detail: string | null;
}

/** A card as both hosts hold it: `CardLike` plus its on-accept steps. */
export interface DecisionCardData extends CardLike {
  onAccept: readonly string[];
}

/**
 * The card body in spec order: question, options, on-accept steps, the
 * host's slot (a review's attachments), then the evidence — collapsed when
 * the card has options, and left out when it only repeats the question.
 */
export function DecisionCardBody({
  card,
  evidence,
  focusedOption,
  optionDescId,
  children,
}: {
  card: DecisionCardData;
  /** Markdown; the item's description or content. */
  evidence: string;
  focusedOption: string | null;
  optionDescId: (id: string) => string;
  children?: ReactNode;
}) {
  const shown = evidenceMarkdown(evidence, card.question);
  return (
    <>
      <CardQuestion question={card.question} />
      <CardOptions card={card} focused={focusedOption} descId={optionDescId} />
      <CardOnAccept steps={card.onAccept} />
      {children}
      {shown !== null && <CardEvidence markdown={shown} collapsible={card.options.length > 0} />}
    </>
  );
}

/** "nothing": the key is the shortcut, so it is taken, but it decides nothing here (the fold's toggle, a card that recommends none). */
export type CardShortcut = { kind: "accept"; option?: CardOption } | { kind: "changes" } | { kind: "needs-message" } | { kind: "nothing" };

/**
 * What Ctrl/Cmd+Enter (Shift: Request changes) means on this card, or null
 * when the key is not a decision shortcut. The caller
 * has already checked arming and that a decision is open.
 */
export function cardShortcut(
  e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; target: EventTarget | null },
  card: CardLike | null,
  message: string,
): CardShortcut | null {
  if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey) || e.altKey) return null;
  if (e.shiftKey) return message.trim() === "" ? { kind: "needs-message" } : { kind: "changes" };
  const actions = card === null ? null : cardActions(card);
  if (actions === null || card === null) return { kind: "accept" };
  // On an option's own button the shortcut takes that option, so a focused
  // "Choose B" never accepts the recommendation instead; on the fold's
  // toggle it takes nothing; anywhere else, the recommendation.
  const target = e.target instanceof Element ? e.target : null;
  if (target?.closest("[data-choose-toggle]")) return { kind: "nothing" };
  const focusedId = target?.closest<HTMLElement>("[data-option-id]")?.dataset["optionId"];
  const focused = focusedId === undefined ? undefined : card.options.find((o) => o.id === focusedId);
  const option = focused ?? actions.accept;
  return option === null ? { kind: "nothing" } : { kind: "accept", option };
}

export function DecisionFooter({
  open,
  recipient,
  sessionLinks,
  labels,
  messageLabel = "Message to the agent (required for Request changes)",
  actions,
  message,
  setMessage,
  messageRef,
  needsMessage,
  pending,
  pendingOption,
  onOptionFocus,
  optionDescId,
  outcome,
  refusal,
  decide,
}: {
  open: boolean;
  /** Who the decision will be pushed to (describeRecipient). */
  recipient: string;
  /** Go to the requesting agent / open a session on the item (SessionLinks); null when there is none. */
  sessionLinks: ReactNode;
  labels: FooterLabels;
  /** What the message box is for; the review's default names the agent. */
  messageLabel?: string;
  /** A card's option actions (lib/reviewCard.ts `cardActions`); null keeps plain Accept / Request changes. */
  actions: CardActions | null;
  message: string;
  setMessage: (m: string) => void;
  messageRef: RefObject<HTMLTextAreaElement | null>;
  needsMessage: boolean;
  pending: ReviewDecisionKind | null;
  /** The option being accepted while `pending` is "accept". */
  pendingOption: string | null;
  /** An option's button took or lost focus (null). */
  onOptionFocus: (id: string | null) => void;
  /** The id of an option's what/risk in the list, which its button is described by. */
  optionDescId: (id: string) => string;
  outcome: CardOutcome | null;
  refusal: Refusal | null;
  decide: (decision: ReviewDecisionKind, option?: CardOption) => void;
}) {
  const messageId = useId();
  const labelId = useId();
  const hintId = useId();
  const recipientId = useId();
  const reportRef = useRef<HTMLDivElement>(null);
  const busy = pending !== null;
  const compact = labels.acceptShort !== undefined && labels.changesShort !== undefined;

  // Focus follows the outcome, so a keyboard or screen-reader user lands on
  // what happened — and sits on that line while the write is in flight, so
  // the pressed button disabling never drops focus out of the panel.
  useEffect(() => {
    if (busy || outcome !== null || refusal !== null) reportRef.current?.focus();
  }, [busy, outcome, refusal]);

  const failure: Refusal | null = refusal ?? (outcome !== null && outcome.tone !== "ok" ? { text: outcome.text, detail: null } : null);
  // One row until it is focused or holds a draft, at every width, so the footer leaves the card its height.
  const textareaHeight = message !== "" ? "h-[4.5rem]" : "h-10 focus:h-[4.5rem]";
  const hintElsewhere = labels.hintTarget !== undefined;
  const describedBy = [needsMessage ? hintId : null, hintElsewhere ? recipientId : null].filter((id) => id !== null).join(" ") || undefined;
  const hint = labels.shortcuts && (
    <span aria-hidden="true" className="hidden shrink-0 items-center gap-1 whitespace-nowrap text-xs text-fg-muted lg:inline-flex">
      {actions === null || actions.accept !== null ? (
        <>
          <Kbd>Ctrl/⌘</Kbd>
          <Kbd>Enter</Kbd> accept{actions?.accept ? <> option {actions.accept.id}</> : null} · add <Kbd>Shift</Kbd> to request changes
        </>
      ) : (
        <>
          <Kbd>Ctrl/⌘</Kbd>
          <Kbd>Shift</Kbd>
          <Kbd>Enter</Kbd> request changes
        </>
      )}
    </span>
  );

  return (
    <div className="space-y-2 border-t border-hairline bg-surface-strong p-4">
      {labels.notice !== undefined && <div className="flex min-h-[5.25rem] items-center rounded-lg border border-hairline bg-fg/[0.03] px-3 py-2 text-sm text-fg">{labels.notice}</div>}
      {open && (
        <>
          <label id={labelId} htmlFor={messageId} className="block truncate text-xs text-fg-muted">
            {messageLabel}
          </label>
          <textarea
            id={messageId}
            ref={messageRef}
            rows={1}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            disabled={busy}
            aria-describedby={describedBy}
            title={hintElsewhere ? recipient : undefined}
            className={`block w-full resize-none rounded-lg border border-hairline bg-ground/60 px-3 py-2 text-base text-fg focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-60 sm:text-sm ${textareaHeight}`}
          />
          {needsMessage && (
            <p id={hintId} role="alert" className="text-xs text-amber-200">
              Add a message to request changes.
            </p>
          )}
        </>
      )}
      {open && actions !== null && (
        <div className="space-y-1.5">
          {actions.accept !== null && (
            <OptionAction
              option={actions.accept}
              verb="Accept"
              primary
              suffix={labels.optionSuffix}
              pending={pending === "accept" && pendingOption === actions.accept.id}
              disabled={decisionBlocked("accept", message, busy)}
              keyshortcuts={labels.shortcuts ? "Control+Enter Meta+Enter" : undefined}
              describedBy={optionDescId(actions.accept.id)}
              onFocusChange={onOptionFocus}
              onPress={() => decide("accept", actions.accept!)}
            />
          )}
          {actions.choices.map((o) => (
            <OptionAction
              key={o.id}
              option={o}
              verb="Choose"
              suffix={labels.optionSuffix}
              pending={pending === "accept" && pendingOption === o.id}
              disabled={decisionBlocked("accept", message, busy)}
              describedBy={optionDescId(o.id)}
              onFocusChange={onOptionFocus}
              onPress={() => decide("accept", o)}
            />
          ))}
          {actions.folded.length > 0 && (
            <ChooseAnother
              label={foldLabel(actions)}
              options={actions.folded}
              suffix={labels.optionSuffix}
              busy={busy}
              optionDescId={optionDescId}
              onOptionFocus={onOptionFocus}
              pendingOption={pending === "accept" ? pendingOption : null}
              disabled={decisionBlocked("accept", message, busy)}
              onChoose={(o) => decide("accept", o)}
            />
          )}
        </div>
      )}
      {(open || labels.extra !== undefined) && (
        <div className={`flex items-center gap-2 ${compact ? "max-sm:flex-nowrap max-sm:[&>button]:flex-1 sm:flex-wrap" : "flex-wrap"}`}>
          {open && (
            <>
              {actions === null && (
                <button
                  type="button"
                  onClick={() => decide("accept")}
                  disabled={decisionBlocked("accept", message, busy)}
                  aria-keyshortcuts={labels.shortcuts ? "Control+Enter Meta+Enter" : undefined}
                  className="min-h-11 rounded-lg bg-accent px-4 text-sm font-semibold text-ground hover:bg-accent/90 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-ground disabled:opacity-60 sm:min-h-10"
                >
                  {pending === "accept" ? "Accepting…" : <Label full={labels.acceptLabel} short={labels.acceptShort} />}
                </button>
              )}
              <button
                type="button"
                onClick={() => decide("changes")}
                disabled={decisionBlocked("changes", message, busy)}
                aria-describedby={message.trim() === "" ? labelId : undefined}
                aria-keyshortcuts={labels.shortcuts ? "Control+Shift+Enter Meta+Shift+Enter" : undefined}
                className={`min-h-11 rounded-lg border border-amber-400/50 bg-amber-400/10 px-4 text-sm font-medium text-amber-200 hover:bg-amber-400/20 focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-10 ${actions !== null ? "flex-1" : ""}`}
              >
                {pending === "changes" ? "Sending…" : <Label full={labels.changesLabel} short={labels.changesShort} />}
              </button>
            </>
          )}
          {labels.extra?.({ busy })}
        </div>
      )}
      {open && !hintElsewhere && (
        <div className={`flex items-center gap-x-4 text-xs text-fg-muted ${compact ? "max-sm:hidden" : ""}`}>
          <span title={recipient} className="min-w-0 flex-1 truncate">
            {recipient}
          </span>
          {hint}
        </div>
      )}
      {open && hintElsewhere && (
        <span id={recipientId} hidden>
          {recipient}
        </span>
      )}
      {open && sessionLinks}
      {open && labels.hintTarget && createPortal(hint, labels.hintTarget)}
      <div ref={reportRef} tabIndex={-1} className="focus:outline-none">
        {failure !== null ? (
          <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {failure.text}
            {failure.detail !== null && <span className="mt-1 block break-words font-mono text-xs text-fg-muted">{failure.detail}</span>}
            {refusal === null && outcome?.notified && <span className="mt-1 block text-fg-muted">{outcome.notified}</span>}
          </div>
        ) : (
          <p role="status" className="text-xs text-emerald-300">
            {busy && <span className="text-fg-muted">Writing the decision…</span>}
            {outcome && (
              <>
                {outcome.text}
                {outcome.notified && <span className="block text-fg-muted">{outcome.notified}</span>}
              </>
            )}
          </p>
        )}
      </div>
    </div>
  );
}

const OPTION_BUTTON_BASE = "flex min-h-11 w-full items-center gap-2 rounded-lg px-4 text-left text-sm focus:outline-none focus:ring-2 disabled:opacity-60 sm:min-h-10 lg:min-h-9";
const OPTION_BUTTON_PRIMARY = `${OPTION_BUTTON_BASE} bg-accent font-semibold text-ground hover:bg-accent/90 focus:ring-accent focus:ring-offset-2 focus:ring-offset-ground`;
const OPTION_BUTTON_OTHER = `${OPTION_BUTTON_BASE} border border-accent/40 bg-accent/[0.06] font-medium text-fg hover:bg-accent/15 focus:ring-accent`;

/**
 * "Accept <label>" (primary) or "Choose <label>", the option id in a mono
 * prefix. The visible text starts the accessible name; the id follows it
 * there ("(option B)"), since the prefix is hidden from it.
 */
function OptionAction({
  option,
  verb,
  primary = false,
  suffix,
  pending,
  disabled,
  keyshortcuts,
  describedBy,
  onFocusChange,
  onPress,
  buttonRef,
  onKeyDown,
}: {
  option: CardOption;
  verb: "Accept" | "Choose";
  primary?: boolean;
  suffix: string | undefined;
  pending: boolean;
  disabled: boolean;
  /** Only the recommendation's button declares the shortcut; Ctrl/Cmd+Enter on any option's button takes that option (the panel's key handler reads `data-option-id`). */
  keyshortcuts?: string;
  describedBy: string;
  onFocusChange: (id: string | null) => void;
  onPress: () => void;
  buttonRef?: (el: HTMLButtonElement | null) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      data-option-id={option.id}
      onClick={onPress}
      onKeyDown={onKeyDown}
      onFocus={() => onFocusChange(option.id)}
      onBlur={() => onFocusChange(null)}
      disabled={disabled}
      aria-keyshortcuts={keyshortcuts}
      aria-describedby={describedBy}
      className={primary ? OPTION_BUTTON_PRIMARY : OPTION_BUTTON_OTHER}
    >
      {!primary && (
        <span aria-hidden="true" className="shrink-0 font-mono text-xs text-fg-muted">
          {option.id}
        </span>
      )}
      <span className="min-w-0 truncate">
        {pending ? (
          `Accepting ${option.id}…`
        ) : (
          <>
            {verb} <InlineText text={option.label} />
          </>
        )}
      </span>
      <span className="sr-only">
        {" "}
        (option {option.id}
        {primary ? ", recommended" : ""})
      </span>
      {suffix !== undefined && !pending && <span className={`ml-auto shrink-0 text-xs font-normal max-sm:hidden ${primary ? "text-ground/80" : "text-fg-muted"}`}>{suffix}</span>}
    </button>
  );
}

/**
 * More choices than fit inline: one disclosure button ("Choose another…",
 * or "Choose an option…" on a card with no recommendation) that shows them
 * as a list of Choose actions under it (keyboard: Tab, or the arrow keys,
 * Home and End between them; Escape in the list or on the open button
 * closes the list and stays on the button, without leaving the panel or the
 * run). The button is disabled while a decision is being written.
 */
function ChooseAnother({
  label,
  options,
  suffix,
  busy,
  optionDescId,
  onOptionFocus,
  pendingOption,
  disabled,
  onChoose,
}: {
  label: string;
  options: readonly CardOption[];
  suffix: string | undefined;
  busy: boolean;
  optionDescId: (id: string) => string;
  onOptionFocus: (id: string | null) => void;
  pendingOption: string | null;
  disabled: boolean;
  onChoose: (option: CardOption) => void;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (open) itemRefs.current[0]?.focus();
  }, [open]);

  function onItemKeyDown(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    const last = options.length - 1;
    const target = e.key === "ArrowDown" ? (i === last ? 0 : i + 1) : e.key === "ArrowUp" ? (i === 0 ? last : i - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : null;
    if (target !== null) {
      e.preventDefault();
      itemRefs.current[target]?.focus();
    } else if (e.key === "Escape") {
      // Taken here (preventDefault), so neither the panel nor a dialog around it treats it as leaving.
      e.preventDefault();
      setOpen(false);
      toggleRef.current?.focus();
    }
  }

  function onToggleKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "Escape" && open) {
      e.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div>
      <button
        ref={toggleRef}
        type="button"
        data-choose-toggle=""
        aria-expanded={open}
        aria-controls={listId}
        disabled={busy}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onToggleKeyDown}
        className={OPTION_BUTTON_OTHER}
      >
        <span className="min-w-0 truncate">{label}</span>
        <span className="ml-auto shrink-0 text-xs font-normal text-fg-muted">
          {options.map((o) => o.id).join(" · ")} <span aria-hidden="true">{open ? "▴" : "▾"}</span>
        </span>
      </button>
      {open && (
        <ul id={listId} aria-label={label.replace("…", "")} className="mt-1.5 space-y-1.5 border-l-2 border-hairline pl-2">
          {options.map((o, i) => (
            <li key={o.id}>
              <OptionAction
                option={o}
                verb="Choose"
                suffix={suffix}
                pending={pendingOption === o.id}
                disabled={disabled}
                describedBy={optionDescId(o.id)}
                onFocusChange={onOptionFocus}
                onPress={() => onChoose(o)}
                onKeyDown={(e) => onItemKeyDown(e, i)}
                buttonRef={(el) => {
                  itemRefs.current[i] = el;
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Label({ full, short }: { full: string; short: string | undefined }) {
  if (short === undefined) return <>{full}</>;
  return (
    <>
      <span className="sm:hidden">{short}</span>
      <span className="hidden sm:inline">{full}</span>
    </>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-b-2 border-hairline px-1 font-mono text-xs text-fg">{children}</kbd>;
}
