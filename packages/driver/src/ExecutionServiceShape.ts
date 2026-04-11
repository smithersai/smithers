import { Effect } from "effect";
import type { SmithersError } from "@smithers/errors";
import type { TaskOutput } from "@smithers/core/workflow-types";
import type { ExecutionInput } from "./ExecutionInput.ts";

export type ExecutionServiceShape = {
  readonly execute: (
    input: ExecutionInput,
  ) => Effect.Effect<TaskOutput, SmithersError>;
};
