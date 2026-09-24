import { diffStatus } from "../git/diffStatus.ts";
import { effectivePath } from "../git/effectivePath.ts";
import type { DiffRecord } from "../git/diffRecord.ts";
import type { PreviewOutput } from "../workflow/previewOutputSchema.ts";
import type { Changes } from "./changesSchema.ts";

/**
 * Turns one already-read set of diff records into the walkthrough's file list.
 *
 * Pure over the records it is handed, so the walkthrough describes exactly the
 * change set the preview and the review prompts were built from.
 */
export function changesFromDiffs(diffs: Array<DiffRecord>, preview: PreviewOutput): Changes {
  const previewByPath = new Map(preview.entries.map((entry) => [entry.path, entry]));
  const files = diffs.map((diff) => {
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
