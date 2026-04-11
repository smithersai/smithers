import { Data } from "effect";
import type { GenericTaggedErrorArgs } from "./TaggedErrorDetails";

export class InvalidInput extends Data.TaggedError("InvalidInput")<
  GenericTaggedErrorArgs
> {}
