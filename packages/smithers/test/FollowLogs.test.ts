/** Following a terminal run drains its events and exits, including empty cursor pages. */
import { execFile } from "node:child_process"
import { access, copyFile, mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, it } from "vitest"

const run = promisify(execFile)
const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
const preload = fileURLToPath(new URL("./fixtures/init-native-host.ts", import.meta.url))
it("drains completed run logs and exits even when the cursor is past the terminal event", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-follow-logs-")))
  const cli = async (...args: string[]) => {
    try {
      return {
        ...await run(process.execPath, ["--no-warnings", "--import", preload, bin, ...args, "--json"], {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            TMPDIR: process.env.TMPDIR,
            HOME: root,
            XDG_CONFIG_HOME: join(root, "config"),
            XDG_DATA_HOME: join(root, "data"),
            SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY,
            OPENAI_API_KEY: "fixture-never-sent",
            SMITHERS_BACKEND: "sqlite"
          },
          timeout: 60_000
        }),
        code: 0
      }
    } catch (error) {
      return error as { code: number; stdout: string; stderr: string }
    }
  }
  try {
    const initialized = await cli("init", "hello")
    expect(initialized.code, initialized.stdout + initialized.stderr).toBe(0)
    const started = await cli("flow", "start", "hello")
    expect(started.code, started.stdout + started.stderr).toBe(0)
    const { runId } = JSON.parse(started.stdout)
    const followed = await cli("runs", "logs", runId, "--follow")
    expect(followed.code, followed.stdout + followed.stderr).toBe(0)
    expect(followed.stdout).toContain("control.run.completed")
    expect(followed.stdout).toContain("Checked the generated starter.")
    const empty = await cli("runs", "logs", runId, "--follow", "--after", "1000000")
    expect(empty.code, empty.stdout + empty.stderr).toBe(0)
    expect(JSON.parse(empty.stdout)).toEqual([])

    const failing = join(root, ".smithers/flows/failing")
    await mkdir(failing, { recursive: true })
    await copyFile(new URL("./fixtures/bin-failing/flow.ts", import.meta.url), join(failing, "flow.ts"))
    const failed = await cli("flow", "start", "failing")
    expect(failed.code, failed.stdout + failed.stderr).toBe(1)
    const failureLogs = await cli("runs", "logs", JSON.parse(failed.stdout).runId, "--follow")
    expect(failureLogs.code, failureLogs.stdout + failureLogs.stderr).toBe(0)
    expect(failureLogs.stdout).toContain("control.run.failed")

    const idle = join(root, ".smithers/flows/idle")
    await mkdir(idle, { recursive: true })
    await copyFile(new URL("./fixtures/idle/flow.ts", import.meta.url), join(idle, "flow.ts"))
    const marker = join(root, "entered")
    const launched = await cli("flow", "start", "idle", "--data", JSON.stringify({ marker }), "-d")
    expect(launched.code, launched.stdout + launched.stderr).toBe(0)
    const activeId = JSON.parse(launched.stdout).runId
    let entered = false
    for (let attempt = 0; attempt < 100; attempt++) {
      entered = await access(marker).then(() => true, () => false)
      if (entered) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(entered, "detached action entered its real native body").toBe(true)
    let settled = false
    const live = cli("runs", "logs", activeId, "--follow").then((result) => {
      settled = true
      return result
    })
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(settled).toBe(false)
    const cancelled = await cli("runs", "cancel", activeId)
    expect(cancelled.code, cancelled.stdout + cancelled.stderr).toBe(0)
    const drained = await live
    expect(drained.code, drained.stdout + drained.stderr).toBe(0)
    expect(drained.stdout, drained.stdout + drained.stderr).toContain("control.run.cancelled")
  } finally {
    await cli("runs", "cancel-all")
    await rm(root, { recursive: true, force: true })
  }
}, 180_000)
