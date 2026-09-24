import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failureDetail, finishedStatus, readSummary } from "../../action/src/reviewSummary.ts";

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

test("a finished run is a pass only when its status is success and no file review failed", () => {
  const counts = { files: 8, findings: 2, inline: 1 };
  expect(finishedStatus(summaryFile({ ...counts, status: "success", failedFileReviews: 0 })!)).toBe(
    "✅ smithers review: reviewed 8 files, 2 findings (1 inline)",
  );
  expect(finishedStatus(summaryFile({ ...counts, status: "completed_with_warnings", failedFileReviews: 1 })!)).toBe(
    "⚠️ smithers review partial: 1 file review failed; reviewed 8 files, 2 findings (1 inline)",
  );
  expect(finishedStatus(summaryFile({ ...counts, status: "completed_with_warnings", failedFileReviews: 0 })!)).toBe(
    "⚠️ smithers review completed with warnings: reviewed 8 files, 2 findings (1 inline)",
  );
  expect(finishedStatus(summaryFile({ ...counts })!)).toBe(
    "⚠️ smithers review finished without a status: reviewed 8 files, 2 findings (1 inline)",
  );
  expect(finishedStatus(summaryFile({ files: 3, findings: 0, inline: 0, status: "skipped" })!)).toBe(
    "⏭️ smithers review skipped",
  );
});

test("the walkthrough link or its publish failure follows the counts", () => {
  const base = { files: 1, findings: 1, inline: 0, status: "success" };
  expect(finishedStatus(summaryFile({ ...base, walkthroughUrl: " https://w.test/1 " })!)).toBe(
    "✅ smithers review: reviewed 1 file, 1 finding (0 inline) — [walkthrough](https://w.test/1)",
  );
  expect(finishedStatus(summaryFile({ ...base, publishError: "503" })!)).toBe(
    "✅ smithers review: reviewed 1 file, 1 finding (0 inline) — walkthrough publish failed; see the job log",
  );
});
