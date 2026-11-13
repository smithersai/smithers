import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import * as Detached from "../src/Detached.ts"
import { spawnNodeSync } from "./support/node-child.ts"

// A fresh process has no earlier test high-water mark to hide a full-log copy.
const peakLimitKiB = 224 * 1024
const probe = (retain: boolean) => {
  const child = spawnNodeSync([
    "--input-type=module",
    "-e",
    `
    import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import * as Detached from ${JSON.stringify(new URL("../src/Detached.ts", import.meta.url).href)};
    const root = mkdtempSync(join(tmpdir(), "smithers-admission-memory-"));
    try {
      const startupKiB = process.resourceUsage().maxRSS;
      const entry = join(root, "child.mjs");
      writeFileSync(entry, \`
        import { ftruncateSync, writeSync } from "node:fs";
        ftruncateSync(2, 256 * 1024 * 1024);
        writeSync(2, "\\\\nSMITHERS_DETACHED_ADMISSION=run:" + process.env.SMITHERS_INTERNAL_DETACHED_ADMISSION + " runId=run-memory\\\\n");
      \`);
      const result = await Detached.launch({ root, entry, payload: "{}", admission: async () => true, timeoutMs: 10000 });
      const retained = ${retain} ? readFileSync(result.logFile) : undefined;
      console.log(JSON.stringify({ startupKiB, peakKiB: process.resourceUsage().maxRSS, result, retainedBytes: retained?.length ?? 0 }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  `
  ], { encoding: "utf8", timeout: 30_000 })
  expect(child.error).toBeUndefined()
  expect(child.status, child.stderr).toBe(0)
  return JSON.parse(child.stdout) as {
    startupKiB: number
    peakKiB: number
    result: { runId: string }
    retainedBytes: number
  }
}

it("admits a run beyond a large sparse log within a fresh launcher's absolute memory bound", () => {
  const measured = probe(false)
  expect(measured.result).toHaveProperty("runId", "run-memory")
  expect(measured.startupKiB).toBeLessThan(192 * 1024)
  expect(measured.peakKiB).toBeLessThan(peakLimitKiB)
})

it("rejects a positive control that deliberately retains the entire log", () => {
  const measured = probe(true)
  expect(measured.result).toHaveProperty("runId", "run-memory")
  expect(measured.startupKiB).toBeLessThan(192 * 1024)
  expect(measured.retainedBytes).toBeGreaterThanOrEqual(256 * 1024 * 1024)
  expect(measured.peakKiB).toBeGreaterThanOrEqual(peakLimitKiB)
})

it("refuses excessive distinct admission claims instead of retaining them indefinitely", async () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-admission-claims-"))
  try {
    const entry = join(root, "child.mjs")
    writeFileSync(
      entry,
      `import { writeSync } from 'node:fs';
      for (let n = 0; n < 4096; n++) writeSync(2, 'SMITHERS_DETACHED_ADMISSION=run:' + process.env.SMITHERS_INTERNAL_DETACHED_ADMISSION + ' runId=run-' + n + '\\n');`
    )
    const result = await Detached.launch({ root, entry, payload: "{}", admission: async () => false, timeoutMs: 10000 })
    expect(result).toHaveProperty("reason", expect.stringContaining("admission candidate limit"))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
