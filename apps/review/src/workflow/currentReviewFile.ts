import * as Context from "effect/Context";

/** Per-action context, inherited by its model events without crossing file fibers. */
export const CurrentReviewFile = Context.Reference<string>("smithers-review/CurrentReviewFile", {
  defaultValue: () => "",
});
