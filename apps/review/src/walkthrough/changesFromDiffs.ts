import {
  diffStatus,
  effectivePath,
  type DiffRecord,
  type PreviewOutput,
} from "../workflow/openCodeReview.ts";
import type { Changes } from "./changesSchema.ts";

/**
 * Turns one already-read set of diff records into the walkthrough's file list.
 *
 * Pure over the records it is handed, so the walkthrough describes exactly the
 * change set the preview and the review prompts were built from.
 */
export function changesFromDiffs(diffs: Array<DiffRecord>, preview: PreviewOutput): Changes {
  const previewByPath = new Map(preview.entries.map((entry) => [entry.path, entry]));
  const files = diffs
    // The app's own state dir: in not-yet-gitignored repos its db would show
    // up as a giant untracked "added" file on the very change set it reviews.
    .filter(
      (diff) => effectivePath(diff) !== ".smithers-review" && !effectivePath(diff).startsWith(".smithers-review/"),
    )
    .map((diff) => {
      const path = effectivePath(diff);
      const entry = previewByPath.get(path);
      // Untracked binaries are inlined as synthetic +lines by the workspace
      // diff; a NUL byte means this is not reviewable text.
      const binary = diff.isBinary || diff.diff.includes("\u0000");
      return {
        path,
        status: binary ? "binary" : diffStatus(diff),
        insertions: diff.insertions,
        deletions: diff.deletions,
        diff: binary ? "" : diff.diff,
        reviewed: entry?.willReview ?? false,
        excludeReason: entry?.excludeReason ?? "",
      };
    });
  return {
    files,
    totalFiles: files.length,
    totalInsertions: files.reduce((sum, file) => sum + file.insertions, 0),
    totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0),
  };
}
