// Pure helpers behind a decision card in the review panel
// (decision-card-reviews, design.md decisions 5 and 7): the order its
// options are listed in, the decision actions it offers, what an accept
// sends as `seen`, how a chosen option is announced, whether its evidence is
// worth showing, which refusals mean the card moved underneath, and how
// option text marks inline code. Structural types only — the card is core's
// `reviewCard`, served by `boardItem` (server/dto.ts, which also says whether
// the review was filed as a card) — so nothing from the server or core
// reaches the bundle.

export interface CardOption {
  id: string;
  label: string;
  what?: string;
  risk?: string;
}

export interface CardLike {
  question: string;
  options: readonly CardOption[];
  recommend: string | null;
}

/** The recommended option, or null when the card recommends none. */
export function recommendedOption(card: CardLike): CardOption | null {
  return card.recommend === null ? null : (card.options.find((o) => o.id === card.recommend) ?? null);
}

/** The options as listed: the recommended one first, the rest in the card's order. */
export function orderedOptions(card: CardLike): CardOption[] {
  const recommended = recommendedOption(card);
  return recommended === null ? [...card.options] : [recommended, ...card.options.filter((o) => o !== recommended)];
}

/**
 * More "Choose" actions than this fold into one "Choose another…" control,
 * so the footer never pushes the recommendation below the fold. A card that
 * recommends nothing has no Accept button, so it shows one Choose more.
 */
export const MAX_INLINE_CHOICES = 2;

export interface CardActions {
  /** "Accept <label>" — the recommended option; null when the card recommends none. */
  accept: CardOption | null;
  /** One "Choose <label>" each, in the card's order. */
  choices: CardOption[];
  /** Behind the fold control (`foldLabel`); empty unless the choices would be more than fit inline. */
  folded: CardOption[];
}

/** The fold control's label: "Choose another…" beside a recommendation, "Choose an option…" without one. */
export function foldLabel(actions: Pick<CardActions, "accept">): string {
  return actions.accept === null ? "Choose an option…" : "Choose another…";
}

/**
 * The decision actions of a card with options (design.md decision 7);
 * null for a card without options (and so for a legacy review), which keeps
 * plain Accept / Request changes. Request changes is always offered and is
 * not listed here.
 */
export function cardActions(card: CardLike): CardActions | null {
  if (card.options.length === 0) return null;
  const accept = recommendedOption(card);
  const others = card.options.filter((o) => o !== accept);
  const inline = accept === null ? MAX_INLINE_CHOICES + 1 : MAX_INLINE_CHOICES;
  return others.length > inline ? { accept, choices: [], folded: others } : { accept, choices: others, folded: [] };
}

export interface OptionSeen {
  question: string;
  label: string;
  what?: string;
  risk?: string;
}

/**
 * What an accept with an option sends as `seen` (design.md decision 5): the
 * card's question and the option's label, what, and risk exactly as shown —
 * which is exactly as the normalized record holds them — with an absent
 * what or risk left out, never sent empty.
 */
export function seenFor(card: Pick<CardLike, "question">, option: CardOption): OptionSeen {
  return {
    question: card.question,
    label: option.label,
    ...(option.what !== undefined ? { what: option.what } : {}),
    ...(option.risk !== undefined ? { risk: option.risk } : {}),
  };
}

/** An option a decision named, and whether it was the card's recommendation. */
export interface ChosenOption {
  id: string;
  recommended: boolean;
}

export function chosenOption(card: Pick<CardLike, "recommend">, option: CardOption): ChosenOption {
  return { id: option.id, recommended: card.recommend === option.id };
}

/** How an accepted option is announced: "Accepted A", or "Chose B (not the recommendation)". */
export function describeChosen(chosen: ChosenOption): string {
  return chosen.recommended ? `Accepted ${chosen.id}` : `Chose ${chosen.id} (not the recommendation)`;
}

/**
 * The evidence to render: the bead description, unless it is blank or only
 * repeats the question (the card form files the question as the description
 * when the card has no body).
 */
export function evidenceMarkdown(content: string, question: string): string | null {
  const trimmed = content.trim();
  return trimmed === "" || trimmed === question.trim() ? null : content;
}

export interface InlineSegment {
  text: string;
  code: boolean;
}

/** Splits `a \`b\` c` into text and code spans — the one inline mark option text, steps, and the question use. Unpaired backticks stay text. */
export function splitInlineCode(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    if (match.index > last) segments.push({ text: text.slice(last, match.index), code: false });
    segments.push({ text: match[1]!, code: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last), code: false });
  return segments;
}

/**
 * Whether a refused decision (its server message) means the card is not the
 * one the person read: an option it no longer offers, an option whose text
 * or question moved, or a card the tracker now holds unreadable
 * (server/review-writer.ts `unknown-option`, `option-changed`,
 * `unreadable-card`). The server sends no refusal code, so this reads the
 * message; cardRoundtrip.test.ts runs each refusal through the real writer
 * and checks it here, so a reworded message fails a test rather than this.
 */
export function isCardMovedRefusal(message: string): boolean {
  return CARD_MOVED.some((pattern) => pattern.test(message));
}

const CARD_MOVED = [/ changed since it was opened /, / does not offer option "/, / carries options the board cannot read /];

/** What the panel says for such a refusal, after re-reading the card. */
export const CARD_MOVED_TEXT = "This card changed while you were reading it. It now shows the current version — read it again before deciding. Nothing was written.";
