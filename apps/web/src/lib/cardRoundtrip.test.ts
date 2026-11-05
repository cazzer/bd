// The drawer's `seen` against the server's check, end to end without a
// database (decision-card-reviews, design.md decision 5): a raw review is
// shaped by server/dto.ts exactly as `boardItem` serves it, the panel's
// `seenFor` builds what an accept sends, and the real review writer — with a
// fake `bd show` returning a raw review — accepts it when the tracker holds
// the same card and refuses it as option-changed when the card moved. Each
// refusal that means "the card moved" is produced by the writer here and
// recognised by `isCardMovedRefusal`, which reads the server's wording; a
// reworded refusal fails this test.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeReviewMetadata, type BoardItem } from "@breakdown/core";
import { describe, expect, it } from "vitest";
import { toBoardItemDto } from "../../server/dto.js";
import { createReviewWriter, ReviewRecordRefusedError, type RunBd, type RunHerdr } from "../../server/review-writer.js";
import { isCardMovedRefusal, seenFor } from "./reviewCard.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "..", "fixtures", "review-cards");
const ID = "shlo-k54.4.1.1";
const BASE = { project: "shlo", cwd: "/checkouts/shlo", externalId: ID } as const;

/** The shlo card as the tracker holds it; no pane, so no notification is attempted. */
function rawShlo(over: Record<string, unknown> = {}): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(join(FIXTURES, "shlo-k54.4.1.1.expected.json"), "utf8")) as Record<string, unknown>;
  delete raw["socket"];
  return { ...raw, pane: null, ...over };
}

function servedCard(raw: unknown) {
  const item: BoardItem = {
    id: "00000000-0000-0000-0000-000000000001",
    externalId: ID,
    sourceSystem: "beads",
    project: "shlo",
    title: "Review",
    content: "",
    status: "open",
    priority: 1,
    issueType: "task",
    assignee: null,
    labels: ["review"],
    closedAt: null,
    closedReason: null,
    updatedAt: new Date("2026-11-05T12:00:00.000Z"),
    isReview: true,
    review: normalizeReviewMetadata(raw),
    comments: [],
    parent: null,
  };
  // Through JSON, as the wire carries it.
  const card = (JSON.parse(JSON.stringify(toBoardItemDto(item))) as ReturnType<typeof toBoardItemDto>).card;
  if (card === null) throw new Error("fixture must be a card");
  return card;
}

function tracker(raw: unknown, status = "open") {
  const writes: string[][] = [];
  const runBd: RunBd = async (args) => {
    if (args[0] === "show") return JSON.stringify([{ id: ID, status, labels: ["review"], metadata: { review: raw } }]);
    writes.push([...args]);
    return "";
  };
  const runHerdr: RunHerdr = async () => {};
  return { writer: createReviewWriter({ runBd, runHerdr }), writes };
}

async function refusalOf(promise: Promise<unknown>): Promise<ReviewRecordRefusedError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ReviewRecordRefusedError);
  return err as ReviewRecordRefusedError;
}

describe("the drawer's seen through the real writer", () => {
  it.each(["A", "B", "C"])("accepts option %s when the tracker holds the card the drawer showed", async (id) => {
    const card = servedCard(rawShlo());
    const option = card.options.find((o) => o.id === id)!;
    const { writer, writes } = tracker(rawShlo());
    const result = await writer.write({ ...BASE, decision: "accept", message: "", option: id, seen: seenFor(card, option) });
    expect(result.ok).toBe(true);
    expect(writes[0]).toEqual(["comments", "add", ID, `Accepted: ${id}.`]);
  });

  it("accepts an option without what or risk, the absent keys left out on both sides", async () => {
    const raw = rawShlo({ options: [{ id: "A", label: "Track first" }, { id: "B", label: "Drop now", risk: "unseen callers" }], recommend: "A" });
    const card = servedCard(raw);
    const { writer } = tracker(raw);
    for (const option of card.options) {
      await expect(writer.write({ ...BASE, decision: "accept", message: "", option: option.id, seen: seenFor(card, option) })).resolves.toMatchObject({ ok: true });
    }
  });

  it("refuses as option-changed, writing nothing, when the tracker's card moved after the drawer read it", async () => {
    const card = servedCard(rawShlo());
    const options = (rawShlo()["options"] as Array<Record<string, unknown>>).map((o) => (o["id"] === "B" ? { ...o, label: "Drop the table" } : o));
    const { writer, writes } = tracker(rawShlo({ options }));
    const err = await refusalOf(writer.write({ ...BASE, decision: "accept", message: "", option: "B", seen: seenFor(card, card.options[1]!) }));
    expect(err.reason).toBe("option-changed");
    expect(writes).toEqual([]);
    expect(isCardMovedRefusal(err.message)).toBe(true);
  });
});

describe("isCardMovedRefusal against the writer's own refusals", () => {
  const card = servedCard(rawShlo());
  const seenB = seenFor(card, card.options[1]!);

  it("recognises unknown-option and unreadable-card", async () => {
    const unknown = await refusalOf(tracker(rawShlo()).writer.write({ ...BASE, decision: "accept", message: "", option: "Z", seen: seenB }));
    expect(unknown.reason).toBe("unknown-option");
    expect(isCardMovedRefusal(unknown.message)).toBe(true);
    const unreadable = await refusalOf(tracker(rawShlo({ options: [{ id: "A", label: "only one" }], recommend: null })).writer.write({ ...BASE, decision: "accept", message: "", option: "B", seen: seenB }));
    expect(unreadable.reason).toBe("unreadable-card");
    expect(isCardMovedRefusal(unreadable.message)).toBe(true);
  });

  it("does not take the other refusals for a moved card", async () => {
    const required = await refusalOf(tracker(rawShlo()).writer.write({ ...BASE, decision: "accept", message: "" }));
    expect(required.reason).toBe("option-required");
    const legacy = { images: [], pane: null, summary: "Header" };
    const none = await refusalOf(tracker(legacy).writer.write({ ...BASE, decision: "accept", message: "", option: "B", seen: seenB }));
    expect(none.reason).toBe("no-options");
    const closed = await refusalOf(tracker(rawShlo(), "closed").writer.write({ ...BASE, decision: "accept", message: "", option: "B", seen: seenB }));
    expect(closed.reason).toBe("closed");
    for (const err of [required, none, closed]) expect(isCardMovedRefusal(err.message)).toBe(false);
  });
});
