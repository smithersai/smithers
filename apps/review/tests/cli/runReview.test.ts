import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { runReview } from "../../src/cli/runReview.ts";
import { parseReviewArgs } from "../../src/cli/parseReviewArgs.ts";
import { ReviewResult } from "../../src/workflow/reviewSchemas.ts";

test.each(["completed_with_warnings", "failed"] as const)("CLI reports warnings and publishes the execution artifact for %s", async (status) => {
  const dir = mkdtempSync(join(tmpdir(), "review-cli-outcome-"));
  const out = join(dir, "walkthrough.html");
  const artifactPath = join(dir, "execution.html");
  writeFileSync(out, "another run");
  writeFileSync(artifactPath, "this run");
  const warning = { file: "", type: "verifier_error", message: "review-verify: verifier timed out; findings are unverified." };
  const result = Schema.decodeUnknownSync(ReviewResult)({
    target: { repoDir: dir, mode: "workspace", ref: "workspace" },
    review: { status, ok: status !== "failed", warnings: [warning] },
    walkthrough: { path: out, bytes: 8, chapters: 0, files: 1, findings: 0 },
    story: { headline: "", synopsis: "", chapters: [] }, quiz: null,
  });
  Object.assign(result.walkthrough, { artifactPath });
  const run = spyOn(Effect, "runPromise").mockResolvedValue(result);
  const lines: string[] = [];
  const stderr = spyOn(console, "error").mockImplementation((...args) => { lines.push(args.join(" ")); });
  const stdout = spyOn(console, "log").mockImplementation(() => {});
  const exit = spyOn(process, "exit").mockImplementation((() => {}) as typeof process.exit);
  const previousFetch = globalThis.fetch;
  let uploaded = "";
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    uploaded = Buffer.from(init.body as Uint8Array).toString();
    return Response.json({ url: "https://share.test/w/1" });
  }) as typeof fetch;
  const keys = ["SMITHERS_REVIEW_PUBLISH_URL", "SMITHERS_REVIEW_PUBLISH_TOKEN", "SMITHERS_REVIEW_SUMMARY_PATH"] as const;
  const previous = keys.map((key) => process.env[key]);
  process.env.SMITHERS_REVIEW_PUBLISH_URL = "https://share.test";
  process.env.SMITHERS_REVIEW_PUBLISH_TOKEN = "test";
  process.env.SMITHERS_REVIEW_SUMMARY_PATH = join(dir, "summary.json");
  try {
    await runReview(parseReviewArgs([dir, "--no-review", "--no-narrate", "--quiz", "off", "--publish"]));
    expect(lines.join("\n")).toContain(warning.message);
    expect(lines.join("\n")).toContain("verifier_error");
    expect(uploaded).toBe("this run");
    expect(JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")).warnings).toEqual([warning]);
    expect(exit).toHaveBeenCalledWith(status === "failed" ? 1 : 0);
  } finally {
    run.mockRestore(); stderr.mockRestore(); stdout.mockRestore(); exit.mockRestore();
    globalThis.fetch = previousFetch;
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a run refused before it starts leaves its typed cause in the summary file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "review-cli-refused-"));
  const summary = join(dir, "summary.json");
  const keys = [
    "SMITHERS_REVIEW_SEAT", "SMITHERS_REVIEW_CHEAP_SEAT", "SMITHERS_REVIEW_NARRATE_SEAT", "ANTHROPIC_API_KEY",
    "SMITHERS_REVIEW_SUMMARY_PATH",
  ] as const;
  const previous = keys.map((key) => process.env[key]);
  for (const key of keys) delete process.env[key];
  process.env.SMITHERS_REVIEW_SEAT = "anthropic:claude-sonnet-4-5";
  process.env.SMITHERS_REVIEW_SUMMARY_PATH = summary;
  const stderr = spyOn(console, "error").mockImplementation(() => {});
  const exit = spyOn(process, "exit").mockImplementation((() => {}) as typeof process.exit);
  try {
    await runReview(parseReviewArgs([dir, "--quiz", "off"]));
    expect(exit).toHaveBeenCalledWith(1);
    const written = JSON.parse(readFileSync(summary, "utf8"));
    expect(written.status).toBe("failed");
    expect(written.reviewStatus).toBe("failed");
    expect(written.error).toContain("ANTHROPIC_API_KEY");
  } finally {
    stderr.mockRestore(); exit.mockRestore();
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    rmSync(dir, { recursive: true, force: true });
  }
});
