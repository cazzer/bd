// Pure helpers behind a decision card in the review panel
// (decision-card-reviews, design.md decisions 5 and 7): whether a review is
// a card or a legacy review, the order its options are listed in, the
// decision actions it offers, what an accept sends as `seen`, whether its
// evidence is worth showing, and how option text marks inline code.
// Structural types only — the card is core's `reviewCard`, served by
// `boardItem` (server/dto.ts) — so nothing from the server or core reaches
// the bundle.

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

/** The card keys `normalizeReviewMetadata` keeps beside the legacy ones (absent when not given). */
const CARD_KEYS = ["question", "options", "recommend", "on_accept", "attachments"] as const;

/**
 * A review filed as a card — it carries any card key. One that carries none
 * (`images` and `summary` only) is a legacy review, which the panel shows as
 * it always has: its whole summary, its screenshots, its thread.
 */
export function isCardReview(review: object): boolean {
  return CARD_KEYS.some((key) => key in review && (review as Record<string, unknown>)[key] !== undefined);
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

/** More "Choose" actions than this fold into one "Choose another…" control, so the footer never pushes the recommendation below the fold. */
export const MAX_INLINE_CHOICES = 2;

export interface CardActions {
  /** "Accept <label>" — the recommended option; null when the card recommends none. */
  accept: CardOption | null;
  /** One "Choose <label>" each, in the card's order. */
  choices: CardOption[];
  /** Behind "Choose another…"; empty unless the other options are more than MAX_INLINE_CHOICES. */
  folded: CardOption[];
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
  return others.length > MAX_INLINE_CHOICES ? { accept, choices: [], folded: others } : { accept, choices: others, folded: [] };
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
