import { Data } from "effect";
import type { TaggedErrorDetails } from "./TaggedErrorDetails";

export class TaskAborted extends Data.TaggedError("TaskAborted")<{
  readonly message: string;
  readonly details?: TaggedErrorDetails;
  readonly name?: string;
}> {}
