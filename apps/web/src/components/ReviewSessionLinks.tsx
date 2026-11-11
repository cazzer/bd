// The session links on a board review (review-sessions): SessionLinks with
// `reviewSession` behind both. "Go to agent" goes through the review's own
// herdr socket; "Talk it through" opens a tab in the project's checkout.

import { trpc } from "../trpc.js";
import { SessionLinks, type SessionLinkResult } from "./SessionLinks.js";

export interface ReviewSessionLinksProps {
  project: string;
  item: string;
  /** The requesting agent's pane and session were recorded, so there is one to go to. */
  hasRequester: boolean;
}

async function call(project: string, item: string, mode: "focus" | "open"): Promise<SessionLinkResult> {
  const result = await trpc.reviewSession.mutate({ project, item, mode });
  return result.ok ? { ok: true, tab: result.tab } : { ok: false, reason: result.reason };
}

export function ReviewSessionLinks({ project, item, hasRequester }: ReviewSessionLinksProps) {
  return <SessionLinks canFocus={hasRequester} focus={() => call(project, item, "focus")} open={() => call(project, item, "open")} />;
}
