import { describe, expect, it, vi } from "vitest";
import { createPushSink } from "./push.js";

const DIR = "/Users/me/dev/bd";
const ISSUES = [
  { id: "bd-1", title: "Work", status: "open" },
  { id: "bd-2", title: "Review it", status: "open", labels: ["review"], comment_count: 1 },
];
const THREAD = [{ id: 7, author: "caleb", text: "Looks right", created_at: "2026-11-14T08:00:00Z" }];
const APPLIED = { project: "bd", nodes: { created: 0, updated: 1, unchanged: 1 }, edges: { created: 0, updated: 0 }, edges_deleted: 0, changed: true, changed_node_ids: ["n1"] };

function setup({ issues = ISSUES, maxBytes }: { issues?: unknown[]; maxBytes?: number } = {}) {
  const runBd = vi.fn(async (args: readonly string[]) => (args[0] === "list" ? JSON.stringify(issues) : JSON.stringify(THREAD)));
  const send = vi.fn(async () => APPLIED as unknown);
  const sink = createPushSink({ client: { send }, runBdFor: () => runBd, ...(maxBytes === undefined ? {} : { maxBytes }) });
  return { runBd, send, sink };
}

describe("the push sink", () => {
  it("computes the export and pushes it raw, answering what Breakdown applied", async () => {
    const { runBd, send, sink } = setup();
    expect(await sink.push({ dir: DIR, project: "bd" })).toEqual({ changed: true, changedNodeIds: ["n1"], nodes: { created: 0, updated: 1, unchanged: 1 }, edges: { created: 0, updated: 0 } });
    expect(runBd.mock.calls.map((c) => c[0])).toEqual([
      ["list", "--status=all", "--limit=0", "--json"],
      ["comments", "bd-2", "--json"],
    ]);
    const [method, path, body] = send.mock.calls[0] as unknown as [string, string, string];
    expect([method, path]).toEqual(["POST", "/relay/v1/beads-ingest"]);
    expect(JSON.parse(body)).toEqual({ project_key: "bd", path: DIR, issues: ISSUES, comments: { "bd-2": THREAD } });
  });

  it("carries an unchanged review thread forward from its cache instead of fetching it again", async () => {
    const { runBd, send, sink } = setup();
    await sink.push({ dir: DIR, project: "bd" });
    await sink.push({ dir: DIR, project: "bd" });
    expect(runBd.mock.calls.filter((c) => c[0][0] === "comments")).toHaveLength(1);
    expect(JSON.parse((send.mock.calls[1] as unknown as string[])[2]!).comments).toEqual({ "bd-2": THREAD });
  });

  it("re-fetches when a push failed, since the cache moves only on success", async () => {
    const { runBd, send, sink } = setup();
    send.mockRejectedValueOnce(new Error("POST /relay/v1/beads-ingest answered 500 internal"));
    await expect(sink.push({ dir: DIR, project: "bd" })).rejects.toThrow(/500/);
    await sink.push({ dir: DIR, project: "bd" });
    expect(runBd.mock.calls.filter((c) => c[0][0] === "comments")).toHaveLength(2);
  });

  it("refuses a body over the cap before sending, naming the size and the cap", async () => {
    const { send, sink } = setup({ maxBytes: 100 });
    await expect(sink.push({ dir: DIR, project: "bd" })).rejects.toThrow(/^the beads export of bd is \d+ bytes, over the server's push cap of 100 bytes \(8 MiB\); it was not sent$/);
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses an empty export, as a local ingest does", async () => {
    const { send, sink } = setup({ issues: [] });
    await expect(sink.push({ dir: DIR, project: "bd" })).rejects.toThrow("no issues to ingest");
    expect(send).not.toHaveBeenCalled();
  });
});
