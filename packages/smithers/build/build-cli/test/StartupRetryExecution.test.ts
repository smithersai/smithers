import * as Exec from "@smthrs/targets/Exec"
import { Effect } from "effect"
import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { describe, expect, it } from "vitest"
import { executeEffect, ExecutionServices, executionServicesLive } from "../src/internal/PackageRunner.ts"
import type * as Reporter from "../src/Reporter.ts"
import { runnerFixture as fixture } from "./helpers/PackageRunnerFixture.ts"

// `up` counts its runs; `command` needs what `up` built.
const source = `const up = S.Shell.Build({
  shell: "echo ran >> up-runs.txt; mkdir -p out; printf built > out/file", outFiles: ["out/file"], sandbox: "none"
})
const command = S.Shell.Test({ shell: "test \\"$(cat out/file)\\" = built", data: [up], sandbox: "none" })
export const Package = S.Package({ targets: { up, command } })`

/**
 * Runs the plan with the real exec action, whose start policy for `up` is
 * `attemptsMs`: a 1 ms attempt is a start the machine really misses.
 */
const run = async (attemptsMs: readonly [number, ...Array<number>]) => {
  const { root, options, plan } = await fixture(source)
  const output: Array<string> = []
  const reporter: Reporter.Reporter = {
    renderer: "plain",
    begin: () => undefined,
    targetStarted: () => undefined,
    targetFinished: () => undefined,
    toolOutput: (label, _stream, chunk) => output.push(`${label}: ${chunk}`),
    note: () => undefined,
    warn: () => undefined,
    summary: () => undefined,
    close: () => undefined
  }
  const began = Date.now()
  const summary = await Effect.runPromise(
    executeEffect(plan, { ...options, reporter }).pipe(Effect.provideService(ExecutionServices, {
      ...executionServicesLive,
      exec: (settings, payload) =>
        executionServicesLive.exec(settings, payload).pipe(
          payload.argv.join(" ").includes("up-runs.txt")
            ? Effect.provideService(Exec.StartupRetry, { attemptsMs, backoffMs: 10 })
            : (effect) => effect
        )
    }))
  )
  const runs = await Fs.readFile(Path.join(root, "up-runs.txt"), "utf8").catch(() => "")
  const status = Object.fromEntries(summary.results.map((result) => [result.label, result]))
  const keys = Object.fromEntries([...plan.nodes].map(([label, node]) => [label, node.keyPreview]))
  return { summary, status, keys, runs, output: output.join(""), elapsedMs: Date.now() - began }
}

describe.skipIf(process.platform === "win32")("a target the machine was too busy to start", () => {
  it("runs after its first start missed, and its dependent runs instead of being skipped", async () => {
    const { summary, status, keys, runs, output } = await run([1, 60_000])
    expect(summary.ok, JSON.stringify(summary.results)).toBe(true)
    expect(status["//:up"]?.status).toBe("ran")
    expect(status["//:command"]?.status).toBe("ran")
    expect(runs).toBe("ran\n")
    // A retried start is the same action: its key is the planned one.
    expect(status["//:up"]?.key).toBe(keys["//:up"])
    expect(status["//:command"]?.key).toBe(keys["//:command"])
    expect(output).toContain(
      "//:up: smthrs: the machine was too busy to start the tool within 0.001 s and it never ran; " +
        "starting it again in 0.01 s (attempt 2 of 2)"
    )
  }, 120_000)

  it("fails with a reason apart from a command failure once no start succeeded", async () => {
    const { summary, status, runs, elapsedMs } = await run([1, 1])
    expect(summary.ok).toBe(false)
    expect(status["//:up"]?.status).toBe("failed")
    expect(status["//:up"]?.error).toMatch(
      new RegExp(
        "^command did not start: /bin/sh -c .*up-runs\\.txt.*\\n" +
          "the machine was too busy to start the tool: 2 attempts in \\d+ s\\n" +
          "TimedOut: ChildProcess\\.spawn \\(/bin/sh\\): The machine was too busy to start the process within 0\\.001 s$"
      )
    )
    expect(status["//:command"]).toMatchObject({ status: "skipped", blockedBy: "//:up" })
    expect(runs).toBe("")
    expect(elapsedMs).toBeLessThan(60_000)
  }, 120_000)
})
