import { Data } from "effect";

export class RunNotFound extends Data.TaggedError("RunNotFound")<{
  readonly message: string;
  readonly runId: string;
}> {}
