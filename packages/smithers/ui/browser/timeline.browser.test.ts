/** The existing Chromium target runs the screenshot generator and its 50-arc bounds assertions. */
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("timeline screenshot generation checks the 50-arc layout at both viewport sizes", async () => {
  const output = await mkdtemp(join(tmpdir(), "timeline-screenshots-"));
  try {
    const child = Bun.spawn(["bun", "tests/timeline-screenshots.browser.ts", output], {
      cwd: resolve(import.meta.dir, ".."),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 150_000,
      killSignal: "SIGKILL",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`Timeline browser probe failed (${code}):\n${stdout}\n${stderr}`);
    expect(stdout).toContain("50 arcs at 1440: four levels");
    expect(stdout).toContain("50 arcs at 1280: four levels");
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}, 180_000);
