import { Data } from "effect";
import type { GenericTaggedErrorArgs } from "./TaggedErrorDetails";

export class DbWriteFailed extends Data.TaggedError("DbWriteFailed")<
  GenericTaggedErrorArgs
> {}
