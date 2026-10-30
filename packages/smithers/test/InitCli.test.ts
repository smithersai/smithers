import { temporaryEnvironment } from "./temporaryEnvironment.ts"
/** Generated output crosses the source CLI, planner and durable engine offline. */
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

const run = promisify(execFile)
const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
const preload = fileURLToPath(new URL("./fixtures/init-native-host.ts", import.meta.url))

describe("init through the public CLI", () => {
  it("creates a starter in a project without dependencies, lists, plans and completes it", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-init-cli-")))
    try {
      const env = {
        PATH: process.env.PATH,
        ...temporaryEnvironment(),
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_DATA_HOME: join(root, "data"),
        SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY,
        OPENAI_API_KEY: "fixture-never-sent",
        SMITHERS_BACKEND: "sqlite"
      }
      const command = async (args: ReadonlyArray<string>) => {
        const started = performance.now()
        const stage = [args[0], ...(["flow", "runs"].includes(args[0]!) ? [args[1]] : [])].join(" ")
        try {
          return await run(process.execPath, ["--no-warnings", "--import", preload, bin, ...args, "--json"], {
            cwd: root,
            env,
            timeout: 60_000,
            maxBuffer: 4 * 1024 * 1024
          })
        } finally {
          console.info("cli.stage", { stage, durationMs: Math.round(performance.now() - started) })
        }
      }
      const initialized = JSON.parse((await command(["init", "review_2-final"])).stdout)
      expect(initialized.flow).toMatchObject({
        name: "review_2-final",
        created: true,
        flowFile: join(root, ".smithers/flows/review_2-final/flow.ts")
      })
      expect(existsSync(join(root, "node_modules"))).toBe(false)
      expect(existsSync(join(root, ".smithers/flows/review_2-final/flow.mdx"))).toBe(false)
      const listed = JSON.parse((await command(["flow", "list"])).stdout)
      expect(listed.items).toContainEqual(expect.objectContaining({ flowId: "review_2-final" }))
      const planned = JSON.parse((await command(["flow", "plan", "review_2-final"])).stdout)
      expect(planned.approval).toBeDefined()
      expect(JSON.stringify(planned)).toContain("review_2-final/work")
      await expect(command(["flow", "plan", "review_2-final", "--data", "{\"args\":42}"])).rejects.toMatchObject({
        code: 1,
        stdout: expect.stringContaining("args")
      })
      await command(["flow", "start", "review_2-final", "--data", "{\"args\":\"Inspect this project.\"}", "--wait"])
      // `ps` reads the local file-flow store; install `runs list` reads the backend.
      const page = JSON.parse((await command(["ps", "--flow", "review_2-final"])).stdout)
      expect(page.items).toHaveLength(1)
      expect(page.items[0]).toMatchObject({ flowId: "review_2-final", status: "completed" })
      const events = (await command(["runs", "logs", page.items[0].runId, "--limit", "1000"])).stdout
      expect(events).toContain("control.run.completed")
      expect(events).toContain("Checked the generated starter.")
      const database = new DatabaseSync(join(root, ".flows/engine.db"), { readOnly: true })
      try {
        const outcomes = database.prepare("SELECT * FROM flows_runs WHERE status = 'completed'").all()
        expect(outcomes.length).toBeGreaterThan(0)
      } finally {
        database.close()
      }
      const before = await readFile(join(root, ".smithers/flows/review_2-final/flow.ts"), "utf8")
      expect(JSON.parse((await command(["init", "review_2-final"])).stdout).flow.created).toBe(false)
      expect(await readFile(join(root, ".smithers/flows/review_2-final/flow.ts"), "utf8")).toBe(before)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)
})
