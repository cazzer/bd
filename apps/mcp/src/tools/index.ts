import { hangarTools } from "./hangar.js";
import { readTools } from "./read.js";
import { writeTools } from "./write.js";
import type { ToolDef } from "../types.js";

export { hangarTools } from "./hangar.js";
export { readTools } from "./read.js";
export { writeTools } from "./write.js";

/** All fourteen tools: the store's reads, its writes, then hangar's. */
export const allTools: ToolDef[] = [...readTools, ...writeTools, ...hangarTools];
