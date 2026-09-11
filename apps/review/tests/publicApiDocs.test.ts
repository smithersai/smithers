import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Every export on this app's published surface carries a doc block.
 *
 * The workspace convention is JSDoc on exports, which the imported packages
 * follow throughout. An app is not a package, and applying that to all 100-odd
 * module-internal seams here would buy boilerplate rather than meaning, so the
 * rule is scoped to what `package.json`'s `exports` map actually offers a
 * consumer: those are the names another workspace project can import, and
 * `CONTRIBUTING.md` records the scope.
 *
 * The check is structural, not stylistic: an export whose nearest preceding
 * non-blank line does not close a block comment is undocumented.
 */

/** The entry points in `package.json`'s `exports`, plus the modules the diffs and openCodeReview barrels re-export. */
const surface = [
  "../src/cli/main.ts",
  "../src/diffs/index.ts",
  "../src/diffs/extractDiffAssets.ts",
  "../src/diffs/renderFallbackDiffHtml.ts",
  "../src/diffs/renderPierreFileDiff.ts",
  "../src/workflow/reviewFlow.ts",
  "../src/workflow/reviewLayer.ts",
  "../src/workflow/openCodeReview.ts",
  "../src/workflow/openCodeReviewInputSchema.ts",
  "../src/workflow/reviewModeSchema.ts",
  "../src/workflow/reviewTargetSchema.ts",
  "../src/workflow/previewEntrySchema.ts",
  "../src/workflow/previewOutputSchema.ts",
  "../src/workflow/reviewCommentSeveritySchema.ts",
  "../src/workflow/reviewCommentCategorySchema.ts",
  "../src/workflow/reviewCommentSchema.ts",
  "../src/workflow/reviewWarningSchema.ts",
  "../src/workflow/reviewSummarySchema.ts",
  "../src/workflow/reviewRunStatusSchema.ts",
  "../src/workflow/reviewRunOutputSchema.ts",
  "../src/workflow/nativeReviewFileSchema.ts",
  "../src/workflow/nativeReviewPromptSchema.ts",
  "../src/workflow/nativeReviewAgentOutputSchema.ts",
  "../src/workflow/workflowSummarySchema.ts",
  "../src/workflow/normalizeOpenCodeReviewInput.ts",
  "../src/git/diffRecord.ts",
  "../src/git/effectivePath.ts",
  "../src/git/diffStatus.ts",
  "../src/git/loadDiffs.ts",
  "../src/review/nativeReviewFileResult.ts",
  "../src/review/reviewSnapshot.ts",
  "../src/review/reviewMode.ts",
  "../src/review/validateReviewInput.ts",
  "../src/review/resolveReviewTarget.ts",
  "../src/review/globMatch.ts",
  "../src/review/loadReviewSnapshot.ts",
  "../src/review/previewFromSnapshot.ts",
  "../src/review/previewOpenCodeReview.ts",
  "../src/review/reviewFileTaskId.ts",
  "../src/review/nativeReviewPromptFromSnapshot.ts",
  "../src/review/buildNativeReviewPrompt.ts",
  "../src/review/finalizeNativeReview.ts",
] as const;

/** Export statements that introduce a name; a bare `export { … } from` re-export does not. */
const declaration = /^export (?:const|function|async function|class|interface|type|enum) /;

function undocumented(relative: string): string[] {
  const lines = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8").split("\n");
  const missing: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!declaration.test(lines[index]!)) continue;
    let above = index - 1;
    while (above >= 0 && lines[above]!.trim() === "") above -= 1;
    if (above >= 0 && lines[above]!.trim().endsWith("*/")) continue;
    missing.push(`${relative.replace("../", "")}:${index + 1} ${lines[index]!.trim().slice(0, 60)}`);
  }
  return missing;
}

describe("the published surface is documented", () => {
  for (const relative of surface) {
    test(`${relative.replace("../src/", "")} documents every export`, () => {
      expect(undocumented(relative)).toEqual([]);
    });
  }
});
