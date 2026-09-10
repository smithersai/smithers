import {
  loadReviewSnapshot,
  type OpenCodeReviewInput,
  type PreviewOutput,
} from "../workflow/openCodeReview.ts";
import { changesFromDiffs } from "./changesFromDiffs.ts";
import type { Changes } from "./changesSchema.ts";

/**
 * Full diff records for every changed file, including files the review
 * filters exclude (tests, docs, configs). The review decides what agents
 * look at; the walkthrough shows a human everything.
 *
 * Reads its own snapshot. A caller that already holds one calls
 * `changesFromDiffs` instead, so the tree is never read twice for one review.
 */
export async function collectChanges(input: OpenCodeReviewInput, preview: PreviewOutput): Promise<Changes> {
  const snapshot = await loadReviewSnapshot(input);
  return changesFromDiffs(snapshot.diffs, preview);
}
