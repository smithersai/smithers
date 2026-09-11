import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as barrel from "../../src/workflow/openCodeReview.ts";

/**
 * `openCodeReview.ts` is a re-export barrel kept for one release so existing
 * `@smthrs/review/workflow/openCodeReview` importers keep working. Every name
 * lives in its own domain file under `src/git`, `src/review`, or
 * `src/workflow`; the barrel declares nothing itself.
 */

const barrelSource = readFileSync(
  fileURLToPath(new URL("../../src/workflow/openCodeReview.ts", import.meta.url)),
  "utf8",
);

describe("openCodeReview barrel", () => {
  test("declares nothing and only re-exports", () => {
    const code = barrelSource
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("//"));
    expect(code.filter((line) => !/^export (?:type )?\{ .+ \} from "\.\.?\/.+\.ts";$/.test(line))).toEqual([]);
  });

  test("keeps every runtime name the hub exported", () => {
    expect(Object.keys(barrel).sort()).toEqual(
      [
        "NativeReviewAgentOutput",
        "NativeReviewFile",
        "NativeReviewPrompt",
        "OpenCodeReviewInput",
        "PreviewEntry",
        "PreviewOutput",
        "ReviewComment",
        "ReviewCommentCategory",
        "ReviewCommentSeverity",
        "ReviewMode",
        "ReviewRunOutput",
        "ReviewRunStatus",
        "ReviewSummary",
        "ReviewTarget",
        "ReviewWarning",
        "WorkflowSummary",
        "buildNativeReviewPrompt",
        "diffStatus",
        "effectivePath",
        "finalizeNativeReview",
        "globMatch",
        "loadDiffs",
        "loadReviewSnapshot",
        "nativeReviewPromptFromSnapshot",
        "normalizeOpenCodeReviewInput",
        "previewFromSnapshot",
        "previewOpenCodeReview",
        "resolveReviewTarget",
        "reviewFileTaskId",
        "reviewMode",
        "validateReviewInput",
      ].sort(),
    );
  });
});
