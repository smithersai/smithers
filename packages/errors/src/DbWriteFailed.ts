import { Data } from "effect";
import type { GenericTaggedErrorArgs } from "./TaggedErrorDetails.ts";

export class DbWriteFailed extends Data.TaggedError("DbWriteFailed")<
  GenericTaggedErrorArgs
> {}
