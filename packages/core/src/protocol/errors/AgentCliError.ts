import { Data } from "effect";
import type { GenericTaggedErrorArgs } from "./TaggedErrorDetails";

export class AgentCliError extends Data.TaggedError("AgentCliError")<
  GenericTaggedErrorArgs
> {}
