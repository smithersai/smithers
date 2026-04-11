import { Data } from "effect";
import type { GenericTaggedErrorArgs } from "./TaggedErrorDetails";

export class WorkflowFailed extends Data.TaggedError("WorkflowFailed")<
  GenericTaggedErrorArgs & {
    readonly status?: number;
  }
> {}
