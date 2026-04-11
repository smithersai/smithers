import type { RunOptions } from "../RunOptions";
import type { RunResult } from "../RunResult";
import type { EngineDecision } from "./EngineDecision";
import type { WaitReason } from "./WaitReason";

export type WaitHandler = (
  reason: WaitReason,
  context: { runId: string; options: RunOptions },
) => Promise<EngineDecision | RunResult> | EngineDecision | RunResult;
