// Pure row helpers for the feed view (node-views, design.md decision 6):
// what a `list` row shows beyond its title and type is read straight out
// of its metadata, with no per-type schema — the feed's value is that an
// agent can write any filter and see rows without the web knowing the
// node type (a per-type renderer is the `code` view's job, later). Two
// reads, both loose on purpose: the work-item fields when the value is a
// string or number (present on work items, simply absent otherwise — a
// `status` on a non-work-item is shown if it is there), and every
// top-level string value that is an http(s) URL, as a link whose text is
// the key the writer chose (`url`, `pr_url`, whatever). Nothing here is
// React or touches the DOM; FeedView.tsx renders what these return. Node-
// environment tests in feedRow.test.ts.

/** The work-item fields a row shows when present (work-items contract: `status`, `priority`, `assignee`), rendered as text. `null` means "not shown". */
export interface FeedRowFields {
  status: string | null;
  priority: string | null;
  assignee: string | null;
}

/** A top-level metadata value that is an external link — `key` is the link's text, `href` its target. */
export interface FeedRowLink {
  key: string;
  href: string;
}

const NO_FIELDS: FeedRowFields = { status: null, priority: null, assignee: null };

/** Only `http://` and `https://` count as external links; anything else (a `mailto:`, a bare host, a `javascript:` string) is plain metadata the feed does not render. */
const HTTP_URL_RE = /^https?:\/\//i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string or a finite number, as text; anything else (boolean, null, object, empty/whitespace-only string) is "absent". */
function scalarText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

/** The row's `status`/`priority`/`assignee`, each `null` unless the metadata value is a non-empty string or a finite number. A non-object `metadata` (a hand-edited row) yields no fields. */
export function pickRowFields(metadata: unknown): FeedRowFields {
  if (!isRecord(metadata)) {
    return NO_FIELDS;
  }
  return {
    status: scalarText(metadata["status"]),
    priority: scalarText(metadata["priority"]),
    assignee: scalarText(metadata["assignee"]),
  };
}

/** Every top-level metadata value that is a string beginning `http://` or `https://`, in the metadata's own key order. Nested values are not searched; a non-object `metadata` yields none. */
export function extractLinks(metadata: unknown): FeedRowLink[] {
  if (!isRecord(metadata)) {
    return [];
  }
  const links: FeedRowLink[] = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string" && HTTP_URL_RE.test(value.trim())) {
      links.push({ key, href: value.trim() });
    }
  }
  return links;
}
