import type { RunOptions } from "../RunOptions";
import type { RunResult } from "../RunResult";

export type ContinueAsNewHandler = (
  transition: unknown,
  context: { runId: string; options: RunOptions },
) => Promise<RunResult> | RunResult;
