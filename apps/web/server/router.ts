// The app's whole tRPC surface (bd-hmd.3): four read procedures, six
// write procedures, all thin calls into `@breakdown/core`. `AppRouter` is
// the one thing the client imports — as a type only (see src/trpc.ts) —
// which is what gives end-to-end inference with no code generation step.

import { boardRouter } from "./routers/board.js";
import { boardLiveRouter } from "./routers/board-live.js";
import { readRouter } from "./routers/read.js";
import { writeRouter } from "./routers/write.js";
import { mergeRouters } from "./trpc.js";

export const appRouter = mergeRouters(readRouter, writeRouter, boardRouter, boardLiveRouter);

export type AppRouter = typeof appRouter;
