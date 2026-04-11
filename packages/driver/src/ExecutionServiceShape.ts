import { Effect } from "effect";
import type { SmithersError } from "@smithers/errors/SmithersError";
import type { TaskOutput } from "@smithers/scheduler";
import type { ExecutionInput } from "./ExecutionInput.ts";

export type ExecutionServiceShape = {
  readonly execute: (
    input: ExecutionInput,
  ) => Effect.Effect<TaskOutput, SmithersError>;
};
