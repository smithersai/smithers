import { temporaryEnvironment } from "./temporaryEnvironment.ts"
/** A generated captured coding flow survives loss of its CLI owner, offline. */
import { execFileSync, spawn } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

it("resumes the same generated coding run after SIGKILL during the agent step", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "smithers-generated-resume-")))
  const marker = join(root, "coding-started")
  const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
  const preload = fileURLToPath(new URL("./fixtures/coding-native-host.ts", import.meta.url))
  const children: Array<ReturnType<typeof spawn>> = []
  const env = {
    PATH: process.env.PATH,
    ...temporaryEnvironment(),
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY,
    SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
    OPENAI_API_KEY: "fixture-never-sent",
    SMITHERS_BACKEND: "sqlite"
  }
  const cli = (args: Array<string>, pause = false) => {
    const child = spawn(process.execPath, ["--no-warnings", "--import", preload, bin, ...args, "--json", "--verbose"], {
      cwd: root,
      env: { ...env, ...(pause ? { SMITHERS_TEST_CODING_STARTED: marker } : {}) },
      stdio: ["ignore", "pipe", "pipe"]
    })
    children.push(child)
    let stdout = "", stderr = ""
    child.stdout!.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.stderr!.on("data", (chunk) => {
      stderr += String(chunk)
    })
    const result = new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        child.once("error", reject)
        child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }))
      }
    )
    return { child, result }
  }
  const runs = () => {
    const db = new DatabaseSync(join(root, ".flows", "engine.db"), { readOnly: true, timeout: 10_000 })
    try {
      return db.prepare(
        "SELECT run_id, status FROM (SELECT * FROM flows_runs WHERE COALESCE(json_extract(state_json, '$.flowName'), '') NOT IN ('smithers/health/Discovery', 'smithers/memory/TtlGc'))"
      ).all() as Array<{ run_id: string; status: string }>
    } finally {
      db.close()
    }
  }
  try {
    mkdirSync(env.HOME, { recursive: true })
    symlinkSync(fileURLToPath(new URL("../../../node_modules", import.meta.url)), join(root, "node_modules"), "dir")
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "resume-fixture", type: "module", scripts: { test: "node --test" } })
    )
    writeFileSync(join(root, "index.js"), "export const name = \"slug\"\n")
    writeFileSync(join(root, ".gitignore"), ".flows/\nnode_modules/\nhome/\nconfig/\ndata/\ncoding-started\n")
    execFileSync("jj", ["git", "init", root], { env, stdio: "pipe" })
    execFileSync("jj", ["describe", "-m", "Initial fixture"], { cwd: root, env, stdio: "pipe" })
    execFileSync("jj", ["new"], { cwd: root, env, stdio: "pipe" })
    const generated = await cli(["generate", "flow", "coding"]).result
    expect(generated, JSON.stringify(generated)).toMatchObject({ code: 0 })
    const path = join(root, ".smithers", "flows", "coding", "flow.ts")
    writeFileSync(path, readFileSync(path, "utf8").replaceAll("openai:gpt-6-sol", "openai:gpt-6.1-sol"))
    const started = cli([
      "flow",
      "start",
      "coding",
      "--data",
      JSON.stringify({ args: "Add slugify and tests. Do not commit or merge." })
    ], true)
    const deadline = Date.now() + 120_000
    while (!existsSync(marker)) {
      if (started.child.exitCode !== null || Date.now() > deadline) {
        started.child.kill("SIGKILL")
        throw new Error(`Coding did not start: ${JSON.stringify(await started.result)}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(Number(readFileSync(marker, "utf8"))).toBe(started.child.pid)
    expect(readFileSync(join(root, "index.js"), "utf8")).toContain("coding in progress")
    const db = new DatabaseSync(join(root, ".flows", "engine.db"), { readOnly: true })
    const recorded = db.prepare(
      "SELECT payload_json FROM flows_journal_events WHERE event_type = 'flows.engine.plan-recorded' AND run_id IN (SELECT run_id FROM flows_runs WHERE COALESCE(json_extract(state_json, '$.flowName'), '') NOT IN ('smithers/health/Discovery', 'smithers/memory/TtlGc'))"
    ).all()
    db.close()
    expect(recorded).toHaveLength(1)
    expect(JSON.parse(String(recorded[0]!.payload_json)).graph.nodes).toContainEqual(expect.objectContaining({
      action: "coding/work",
      declaredAt: { path: ".smithers/flows/coding/flow.ts", line: 7 }
    }))
    const before = runs()
    const runId = before.find((row) => row.run_id.startsWith("run-"))!.run_id
    expect(before.find((row) => row.run_id === runId)!.status).toBe("running")
    started.child.kill("SIGKILL")
    expect(await started.result).toMatchObject({ signal: "SIGKILL" })
    const resumed = await cli(["runs", "resume", runId]).result
    expect(resumed, JSON.stringify(resumed)).toMatchObject({ code: 0 })
    expect(runs().find((row) => row.run_id === runId)!.status).toBe("completed")
    expect(runs().filter((row) => row.run_id.startsWith("run-"))).toHaveLength(1)
    expect(readFileSync(join(root, "index.js"), "utf8")).toContain("export function slugify")
    expect(readFileSync(join(root, "index.test.js"), "utf8")).toContain("slugify")
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}, 240_000)
