import { Data } from "effect";
import type { GenericTaggedErrorArgs } from "./TaggedErrorDetails.ts";

export class AgentCliError extends Data.TaggedError("AgentCliError")<
  GenericTaggedErrorArgs
> {}
