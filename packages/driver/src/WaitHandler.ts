import type { RunOptions } from "./RunOptions.ts";
import type { RunResult } from "./RunResult.ts";
import type { EngineDecision, WaitReason } from "@smithers-orchestrator/scheduler";

export type WaitHandler = (
  reason: WaitReason,
  context: { runId: string; options: RunOptions },
) => Promise<EngineDecision | RunResult> | EngineDecision | RunResult;
