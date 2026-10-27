import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

it("keeps eval JSON stdout parseable with silent and verbose logging", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "smthrs-eval-stdout-"))
  try {
    await mkdir(join(root, "evals"))
    await writeFile(
      join(root, "evals", "exact.eval.mjs"),
      `
import { Effect } from ${JSON.stringify(import.meta.resolve("effect"))}
import { CaseExecutor } from ${JSON.stringify(new URL("../agent/evals/src/index.ts", import.meta.url).href)}
import * as Scorer from ${JSON.stringify(new URL("../agent/scorers/src/Scorer.ts", import.meta.url).href)}
import * as Binding from ${JSON.stringify(new URL("../agent/scorers/src/Binding.ts", import.meta.url).href)}
const target = { name: "stdout-target" }
const scorer = Scorer.make({ id: "stdout/exact", version: "1", name: "exact", score: () => Effect.succeed({ score: 1 }) })
export const suite = { name: "exact", concurrency: 1, cases: [{ name: "one", input: 1 }], bindings: [Binding.make({ scorer, appliesTo: target })] }
export const executor = CaseExecutor.make(() => Effect.succeed({ output: 1, stepKey: "stdout-step", latencyMs: 0, target }))
`
    )
    for (const silent of [true, false]) {
      const result = spawnSync(process.execPath, [
        "--no-warnings",
        fileURLToPath(new URL("../src/bin.ts", import.meta.url)),
        "eval",
        "run",
        "exact",
        "--root",
        root,
        "--run-id",
        `stdout-${silent}`,
        "--at",
        "2026-01-01T00:00:00.000Z",
        "--format",
        "json",
        ...(silent ? ["--silent"] : ["--verbose"])
      ], {
        cwd: root,
        encoding: "utf8",
        timeout: 75_000,
        env: {
          ...process.env,
          HOME: root,
          XDG_CONFIG_HOME: root,
          XDG_DATA_HOME: root,
          SMITHERS_REMOTE: ""
        }
      })
      expect(result.status, result.stderr + result.stdout).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ runId: `stdout-${silent}`, suite: "exact" })
      expect(result.stdout).not.toContain("INFO")
      if (silent) expect(result.stderr).not.toContain("flow.run.created")
      else expect(result.stderr).toContain("flow.run.created")
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
