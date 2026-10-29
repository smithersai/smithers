/** Exercise a real browser-launch failure without relying on the host's browser cache. */
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const [directoryName, probe] of [
  [".", "generated-view"],
  [".", "loading"],
  [".", "sharing"],
  [".", "chat-message"],
  [".", "live-state"],
  [".", "notices-phone"],
  ["terminal-frame", "terminal-frame"],
] as const) {
  test(`${probe} setup failure names its probe and retains the launch cause`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "ui-missing-browser-"));
    try {
      const child = Bun.spawn([process.execPath, "test", `./browser/${probe}.browser.test.ts`], {
        cwd: join(import.meta.dir, "..", directoryName),
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: directory },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code).not.toBe(0);
      const output = stdout + stderr;
      expect(output).toContain(`${probe} browser probes`);
      expect(output).toContain("Executable doesn't exist");
      expect(output).not.toMatch(/\(fail\) \(unnamed\)/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
}
