import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { test } from "node:test"
import { createVitest } from "vitest/node"

const alive = (pid) => {
  const ps = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" })
  return ps.stdout.trim() !== "" && !ps.stdout.trim().startsWith("Z")
}

// The worker ignores SIGTERM, as a wedged event loop does, so Vitest SIGKILLs it and no hook in the worker runs.
const wedged = (pids, detached) => `
  import { spawn } from 'node:child_process'
  import { writeFileSync } from 'node:fs'
  import { test } from 'vitest'
  test('leaves a child behind', () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: ${detached} })
    writeFileSync(${JSON.stringify(pids)}, String(child.pid))
    process.on('SIGTERM', () => {})
  })
`

for (const detached of [false, true]) {
  test(`a run kills the ${detached ? "detached " : ""}child of a worker Vitest had to SIGKILL`, async () => {
    const parent = resolve(".cache")
    mkdirSync(parent, { recursive: true })
    const root = mkdtempSync(join(parent, "vitest-orphan-"))
    const pids = join(root, "child.pid")
    const previousExitCode = process.exitCode
    let runner
    let child
    try {
      writeFileSync(join(root, "case.test.js"), wedged(pids, detached))
      runner = await createVitest("test", {
        config: false,
        root,
        watch: false,
        include: ["case.test.js"],
        coverage: { enabled: false },
        reporters: [],
        maxWorkers: 1,
        pool: "forks",
        globalSetup: [resolve("test-utils/test-process-environment.mjs")]
      })
      await runner.start()
      child = Number(readFileSync(pids, "utf8"))
      await runner.close()
      runner = undefined
      assert.equal(alive(child), false, `child ${child} outlived the run`)
    } finally {
      try {
        await runner?.close()
      } finally {
        if (child !== undefined && alive(child)) process.kill(child, "SIGKILL")
        process.exitCode = previousExitCode
        rmSync(root, { recursive: true, force: true })
      }
    }
  })
}
