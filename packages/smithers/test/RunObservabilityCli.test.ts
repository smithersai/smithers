/**
 * What `runs show` and `runs logs` tell an operator about a live run whose flow
 * spawned a child execution, through the real CLI and its separate stores.
 */
import * as Audience from "@smthrs/build-cli/Audience"
import { spawn } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { describe, expect, it, onTestFailed, onTestFinished, vi } from "vitest"
import { createRunsCli } from "../src/cli/ControlCommands.ts"
import { childEnvironment } from "./support/node-child.ts"

const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
const preload = fileURLToPath(new URL("./fixtures/scripted-native-host.ts", import.meta.url))
const observer = new URL("./fixtures/cli-exit-observer.ts", import.meta.url).href
const bootstrapObserver = "data:text/javascript," + encodeURIComponent(`
import { getCompileCacheDir } from "node:module";
import { isMainThread } from "node:worker_threads";
import { recordStage } from ${JSON.stringify(observer)};
if (isMainThread) recordStage(getCompileCacheDir() === undefined ? "node cache disabled" : "node cache enabled");
if (isMainThread) recordStage(process.argv[1]?.endsWith("bin.ts") || process.argv[1]?.endsWith("smithers.mjs") ? "cli process" : "helper process");
`)
const nodeModules = fileURLToPath(new URL("../node_modules", import.meta.url))
const processStages = (root: string) => {
  const directory = join(root, ".flows", "process-receipts")
  if (!existsSync(directory)) return []
  return readdirSync(directory).filter((name) => /^\d+\.jsonl$/.test(name)).slice(-16).map((name) => {
    try {
      const lines = readFileSync(join(directory, name), "utf8").trim().split("\n")
      return {
        pid: Number(name.slice(0, -6)),
        stages: (lines.length > 32 ? [...lines.slice(0, 24), ...lines.slice(-8)] : lines)
          .map((line) => JSON.parse(line) as { stage?: string })
      }
    } catch {
      return { pid: Number(name.slice(0, -6)), stages: [] }
    }
  })
}
const source = `import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, FileSystem, Layer, Schema } from "effect"
const Hold = Action.make("parent/Hold", { payload: { marker: Schema.String }, success: Schema.String, error: Schema.Unknown })
const Child = Flow.make("parent/child", {
  payload: { marker: Schema.String }, success: Schema.String, error: Schema.Unknown,
  body: Node.capture({}, ({ marker }) => Hold.call({ marker }))
})
const Spawn = Action.make("parent/Spawn", { payload: { marker: Schema.String }, success: Schema.String, error: Schema.Unknown })
export const layer = Layer.mergeAll(
  Interpreter.layer(Child),
  Hold.toLayer(({ marker }) => Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(marker, String(process.pid))
    return yield* Effect.never
  })),
  Spawn.toLayer(({ marker }) => Effect.gen(function*() {
    const instance = yield* FlowRuntime.FlowInstance
    return yield* Child.execute({ marker }, { executionId: \`\${instance.executionId}/child\` })
  }))
)
export default Flow.make("parent", {
  description: "Spawn a child that holds until cancelled.",
  capabilities: ["fs:write:**"],
  effects: { reads: [], writes: ["**"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: { marker: Schema.String }, success: Schema.String, error: Schema.Unknown,
  body: Node.capture({}, ({ marker }) => Spawn.call({ marker }))
})`

type Result = { code: number | null; stdout: string; stderr: string }
type CommandProgress = {
  verb: string
  pid: number | undefined
  exitCode: number | null
  signalCode: string | null
  stdoutBytes: number
  stderrBytes: number
}
const activeCommands = new Set<() => CommandProgress>()
const command = (root: string, args: ReadonlyArray<string>, format: ReadonlyArray<string> = ["--json"]) => {
  const child = spawn(
    process.execPath,
    ["--no-warnings", "--import", bootstrapObserver, "--import", preload, bin, ...args, "--root", root, ...format],
    {
      cwd: root,
      env: childEnvironment({
        ...process.env,
        SMITHERS_REMOTE: "",
        SMITHERS_BACKEND: "sqlite",
        XDG_CONFIG_HOME: join(root, "config"),
        SMITHERS_TEST_CLI_EXIT_DIR: join(root, ".flows", "process-receipts"),
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${bootstrapObserver}`.trim()
      })
    }
  )
  let stdout = "", stderr = ""
  const progress = () => ({
    verb: args.slice(0, 2).join(" "),
    pid: child.pid,
    exitCode: child.exitCode,
    signalCode: child.signalCode,
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr)
  })
  activeCommands.add(progress)
  const finished = new Promise<Result>((resolve, reject) => {
    child.stdout.on("data", (chunk) => stdout += chunk)
    child.stderr.on("data", (chunk) => stderr += chunk)
    child.once("error", reject)
    child.once("close", (code) => {
      activeCommands.delete(progress)
      resolve({ code, stdout, stderr })
    })
  })
  return {
    child,
    finished,
    output: () => ({ stdout, stderr, exitCode: child.exitCode, processes: processStages(root) })
  }
}
const controlRun = (root: string) => {
  if (!existsSync(join(root, ".flows", "control.db"))) return undefined
  const db = new DatabaseSync(join(root, ".flows", "control.db"), { readOnly: true, timeout: 1_000 })
  try {
    return db.prepare("SELECT run_id, status FROM flows_runs").get() as { run_id: string; status: string } | undefined
  } finally {
    db.close()
  }
}
const until = async <A>(read: () => A | undefined, diagnostic: () => string = () => ""): Promise<A> => {
  for (let attempt = 0; attempt < 800; attempt++) {
    const result = read()
    if (result !== undefined) return result
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`The run did not reach its child: ${diagnostic()}`)
}
/** `runs logs` as a person at a terminal reads it, through the command's own entry. */
const humanLogs = async (root: string, runId: string) => {
  let printed = ""
  let code = 0
  const terminal = (isTTY: boolean) => ({
    isTTY,
    columns: 160,
    write: (text: string) => {
      printed += text
    }
  })
  // The renderer writes to the invocation's stdout, which outside the root
  // CLI's presentation scope is the process's own.
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    printed += String(chunk)
    return true
  })
  await createRunsCli({
    stdout: terminal(true),
    stderr: terminal(false),
    environment: {},
    presentation: Audience.resolve({ audience: "human", env: {}, stdin: false, stdout: true, stderr: false })
  }).serve(
    ["logs", runId, "--root", root],
    {
      stdout: (text) => {
        printed += text
      },
      exit: (status) => {
        code = status
      }
    }
  ).finally(() => write.mockRestore())
  return { code, printed }
}
const show = async (root: string, runId: string) => {
  const shown = await command(root, ["runs", "show", runId]).finished
  expect(shown.code, shown.stdout + shown.stderr).toBe(0)
  return JSON.parse(shown.stdout)
}

describe("runs show and runs logs on a live parent run", { timeout: 180_000 }, () => {
  it("names the flow, lists the child, advances updatedAt, and prints recorded steps", async () => {
    const started = Date.now()
    const stages: Array<{ stage: string; elapsedMs: number }> = []
    let cleanup:
      | {
        commands: Array<CommandProgress>
        run: ReturnType<typeof controlRun>
        processes: ReturnType<typeof processStages>
      }
      | undefined
    const mark = (stage: string) => stages.push({ stage, elapsedMs: Date.now() - started })
    const reportProgress = () =>
      "Live run progress " + JSON.stringify({
        stages,
        elapsedMs: Date.now() - started,
        cleanup,
        commands: [...activeCommands].map((progress) => progress())
      })
    onTestFailed(({ task }) => {
      const receipt = reportProgress()
      for (const error of task.result?.errors ?? []) error.message += `\n${receipt}`
      console.error(receipt)
    })
    onTestFinished(({ task }) => {
      if (task.result?.state === "pass") console.info(reportProgress())
    })
    mark("create project")
    const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-run-observability-")))
    let runner: ReturnType<typeof command> | undefined
    try {
      const flow = join(root, ".smithers", "flows", "parent", "flow.ts")
      await mkdir(join(root, ".smithers", "flows", "parent"), { recursive: true })
      await symlink(nodeModules, join(root, "node_modules"), "dir")
      await writeFile(flow, source)
      const marker = join(root, "holding")
      mark("launch parent")
      runner = command(root, ["flow", "start", "parent", "--data", JSON.stringify({ marker }), "--wait"])
      mark("await child")
      const runId = await Promise.race([
        until(() => existsSync(marker) ? controlRun(root)?.run_id : undefined, () => JSON.stringify(runner!.output())),
        runner.finished.then((result) => {
          throw new Error(`Flow start exited ${result.code} before its child: ${result.stdout}${result.stderr}`)
        })
      ])
      if (process.env.SMITHERS_CLI_NODE_COMPILE_CACHE !== undefined) {
        const disabled = Boolean(process.env.SMITHERS_CLI_DISABLE_COMPILE_CACHE) ||
          process.env.NODE_V8_COVERAGE !== undefined
        expect(processStages(root).find(({ pid }) => pid === runner!.child.pid)?.stages[0]?.stage)
          .toBe(disabled ? "node cache disabled" : "node cache enabled")
      }

      mark("show live run")
      const run = await show(root, runId)
      expect(run.status).toBe("running")
      expect(run.executionView.root.flowName).toBe("parent")
      expect(run.executionView.current.flowName).toBe("parent")
      expect(run.executions).toMatchObject([
        { executionId: runId, flowName: "parent", status: "running", parent: null, running: "parent/Spawn" },
        { flowName: "parent/child", status: "running", parent: runId, running: "parent/Hold" }
      ])
      expect(run.executions[1].executionId).toMatch(/\/child$/)
      expect(run.updatedAt).toBeGreaterThanOrEqual(run.executions[1].startedAtMs)
      expect(run.diagnosis.status).toBe("running")
      expect(run.diagnosis).not.toHaveProperty("endedAt")
      expect(run).not.toHaveProperty("codeDrift")

      mark("print recorded logs")
      const { code, printed } = await humanLogs(root, runId)
      expect(code, printed).toBe(0)
      expect(printed).toContain("Running parent/Spawn")
      expect(printed).toContain("Started parent/child")
      expect(printed).toContain("Running parent/Hold")
      expect(printed).toContain("End of recorded events")
      expect(printed).toContain(`smthrs runs logs '${runId}' --follow`)
      expect(printed).not.toContain("Stopped watching before settlement")

      mark("edit source and show drift")
      await writeFile(flow, (await readFile(flow, "utf8")).replace("until cancelled.", "until cancelled!"))
      const changed = (await show(root, runId)).codeDrift
      expect(changed.recorded).toBe(run.executionDigest)
      expect(changed.current).toMatch(/^[0-9a-f]{64}$/)
      expect(changed.current).not.toBe(run.executionDigest)
      expect(changed.verdict).toBe("flow changed since the run started; resume needs --allow-code-drift")

      mark("delete source and show drift")
      await unlink(flow)
      const gone = (await show(root, runId)).codeDrift
      expect(gone).toEqual({
        recorded: run.executionDigest,
        verdict: "flow is no longer on disk; the run cannot resume"
      })

      mark("cancel parent")
      const cancelled = await command(root, ["runs", "cancel", runId]).finished
      expect(cancelled.code, cancelled.stdout + cancelled.stderr).toBe(0)
      mark("await cancelled row")
      await until(() => controlRun(root)?.status === "cancelled" ? true : undefined)
      mark("await launcher close")
      await runner.finished
      mark("show cancelled run")
      const settled = await show(root, runId)
      expect(settled.status).toBe("cancelled")
      expect(settled.diagnosis.endedAt).toEqual(expect.any(Number))
      expect(settled.executions[0]).toMatchObject({ executionId: runId, status: "cancelled", running: null })
    } finally {
      let run: ReturnType<typeof controlRun>
      try {
        run = controlRun(root)
      } catch {
        run = undefined
      }
      cleanup = { commands: [...activeCommands].map((progress) => progress()), run, processes: processStages(root) }
      mark("cleanup launcher")
      runner?.child.kill("SIGKILL")
      await runner?.finished
      await rm(root, { recursive: true, force: true })
    }
  })
})
