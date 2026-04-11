import type { Run } from "./Run.ts";

export type RunPatch = Partial<Omit<Run, "runId">>;
