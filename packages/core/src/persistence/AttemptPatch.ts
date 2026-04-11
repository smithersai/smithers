import type { AttemptRow } from "./AttemptRow.ts";

export type AttemptPatch = Partial<
  Omit<AttemptRow, "runId" | "nodeId" | "iteration" | "attempt">
>;
