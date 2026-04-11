import { Data } from "effect";
import type { GenericTaggedErrorArgs } from "./TaggedErrorDetails.ts";

export class InvalidInput extends Data.TaggedError("InvalidInput")<
  GenericTaggedErrorArgs
> {}
