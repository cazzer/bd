import { readTools } from "./read.js";
import { writeTools } from "./write.js";
import type { ToolDef } from "../types.js";

export { readTools } from "./read.js";
export { writeTools } from "./write.js";

/** All eight tools, in the order listed in the ticket/design doc. */
export const allTools: ToolDef[] = [...readTools, ...writeTools];
