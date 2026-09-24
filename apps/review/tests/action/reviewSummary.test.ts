import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failureDetail, readSummary } from "../../action/src/reviewSummary.ts";

const dirs: string[] = [];
afterEach(() => { while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true }); });

/** Writes `value` where the CLI writes its summary and reads it back the way the action does. */
function summaryFile(value: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "review-summary-"));
  dirs.push(dir);
  const path = join(dir, "summary.json");
  writeFileSync(path, JSON.stringify(value));
  return readSummary(path);
}

test("a run refused before it started shows its cause on the PR, not an exit code", () => {
  const summary = summaryFile({ status: "failed", reviewStatus: "failed", error: "smithers-review: ANTHROPIC_API_KEY is not set" });
  expect(failureDetail(summary, 1)).toBe(": smithers-review: ANTHROPIC_API_KEY is not set");
});

test("a cause longer than one status line is cut to 200 characters", () => {
  expect(failureDetail(summaryFile({ error: "x".repeat(500) }), 1)).toBe(`: ${"x".repeat(200)}`);
});

test("failed file reviews win over a cause, and no summary falls back to the exit code", () => {
  expect(failureDetail(summaryFile({ failedFileReviews: 2, error: "ignored" }), 1)).toBe(": 2 file reviews failed");
  expect(failureDetail(summaryFile({ failedFileReviews: 1 }), 1)).toBe(": 1 file review failed");
  expect(failureDetail(readSummary(join(tmpdir(), "absent-review-summary.json")), 3)).toBe(" (exit 3)");
});
