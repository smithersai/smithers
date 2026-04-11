import { Effect } from "effect";
import type { SmithersError } from "../errors.ts";
import type { TaskOutput } from "../session.ts";
import type { ExecutionInput } from "./ExecutionInput.ts";

export type ExecutionServiceShape = {
  readonly execute: (
    input: ExecutionInput,
  ) => Effect.Effect<TaskOutput, SmithersError>;
};
