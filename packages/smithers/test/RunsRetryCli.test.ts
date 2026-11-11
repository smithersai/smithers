/**
 * `smthrs runs retry` through the real CLI, control plane and SQLite engine:
 * a new run of the source's approved plan that serves the steps before the
 * chosen one from the source's record and runs that step and every later one.
 */
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { temporaryEnvironment } from "./temporaryEnvironment.ts"

const execute = promisify(execFile)
const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
const preload = fileURLToPath(new URL("./fixtures/scripted-native-host.ts", import.meta.url))
const modules = fileURLToPath(new URL("../node_modules", import.meta.url))

describe("runs retry", () => {
  let root: string
  /** The source run: it failed at `retry/Work`. */
  let failed: string
  /** The retry of `failed`, which completed. */
  let retried: string

  const command = async (args: ReadonlyArray<string>) => {
    const result = await execute(process.execPath, [
      "--no-warnings",
      "--import",
      preload,
      bin,
      ...args,
      "--root",
      root,
      "--json"
    ], {
      cwd: root,
      env: {
        PATH: process.env["PATH"],
        ...temporaryEnvironment(),
        HOME: join(root, "home"),
        XDG_CONFIG_HOME: join(root, "config"),
        SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: process.env["SMITHERS_WORKSPACE_JJ_EXPORT_BINARY"],
        SMITHERS_FFI_LIBRARY_PATH: process.env["SMITHERS_FFI_LIBRARY_PATH"],
        SMITHERS_BACKEND: "sqlite"
      },
      // Generous: a shared host under load makes one CLI process slow, never wrong.
      timeout: 240_000
    }).then(
      (result) => ({ ...result, code: 0 }),
      (error) => ({ stdout: String(error.stdout), stderr: String(error.stderr), code: error.code as number })
    )
    return { ...result, json: result.stdout.trim() === "" ? undefined : JSON.parse(result.stdout) }
  }

  /** The action calls every run so far executed, in order. */
  const calls = async () => (await readFile(join(root, "calls.log"), "utf8")).trim().split("\n")

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "smithers-runs-retry-")))
    await mkdir(join(root, ".smithers", "flows", "retry"), { recursive: true })
    await symlink(modules, join(root, "node_modules"), "dir")
    await writeFile(join(root, "fail-work"), "")
    await writeFile(
      join(root, ".smithers", "flows", "retry", "flow.ts"),
      `
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Schema } from "effect"
import { appendFileSync, existsSync } from "node:fs"
const call = (name: string) => appendFileSync(${JSON.stringify(join(root, "calls.log"))}, name + "\\n")
const Load = Action.make("retry/Load", { implementationVersion: "v1", payload: {}, success: Schema.String })
const Work = Action.make("retry/Work", { implementationVersion: "v1", payload: {}, success: Schema.String })
const Finish = Action.make("retry/Finish", {
  implementationVersion: "v1", payload: { part: Schema.String }, success: Schema.String
})
export const layer = Layer.mergeAll(
  Load.toLayer(() => Effect.sync(() => { call("load"); return "loaded" }), { implementationVersion: "v1" }),
  Work.toLayer(() => Effect.suspend(() => {
    call("work")
    return existsSync(${
        JSON.stringify(join(root, "fail-work"))
      }) ? Effect.die(new Error("work broke")) : Effect.succeed("worked")
  }), { implementationVersion: "v1" }),
  Finish.toLayer(({ part }) => Effect.sync(() => { call("finish " + part); return part }), { implementationVersion: "v1" })
)
export default Flow.make("retry", {
  description: "Four steps, the second of which fails while fail-work exists", capabilities: ["fs:write:**"],
  effects: { reads: [], writes: ["calls.log"], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: {}, success: Schema.String,
  body: () => Load.call({}).pipe(
    Node.andThen(Work.call({})),
    Node.andThen(Finish.call({ part: "a" })),
    Node.andThen(Finish.call({ part: "b" }))
  )
})
`
    )
    const started = await command(["flow", "start", "retry", "--data", "{}", "--wait"])
    expect(started.code, started.stdout + started.stderr).not.toBe(0)
    expect(started.json, started.stderr).toMatchObject({ status: "failed", cause: "work broke" })
    expect(await calls()).toEqual(["load", "work"])
    failed = started.json.runId
    await rm(join(root, "fail-work"))
  }, 600_000)

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("reruns the failed step and every later one, and serves the earlier ones from the source", async () => {
    const result = await command(["runs", "retry", failed])
    expect(result.code, result.stdout + result.stderr).toBe(0)
    expect(result.json).toMatchObject({ _tag: "Accepted", status: "completed" })
    retried = result.json.runId
    expect(retried).not.toBe(failed)
    // `load` ran once, in the source; the retry ran `work` again and both finishes.
    expect(await calls()).toEqual(["load", "work", "work", "finish a", "finish b"])
    // The source run is left as it was: a retry, not a history fork.
    const source = await command(["runs", "show", failed])
    expect(source.json, source.stderr).toMatchObject({ runId: failed, status: "failed" })
  }, 600_000)

  it("refuses a run with no failed step when no step is named", async () => {
    const result = await command(["runs", "retry", retried])
    expect(result.code).not.toBe(0)
    expect(result.json, result.stderr).toMatchObject({ code: "InvalidInput" })
    expect(result.json.message).toContain(`run ${retried} has no failed step; name the step to retry from`)
  }, 600_000)

  it("refuses an unknown step and lists the steps that ran", async () => {
    const result = await command(["runs", "retry", retried, "--from", "retry/Nope"])
    expect(result.code).not.toBe(0)
    expect(result.json.message, result.stderr).toContain(
      `run ${retried} ran no step retry/Nope; its steps are retry/Load, retry/Work, retry/Finish`
    )
  }, 600_000)

  it("refuses an action that ran more than once, then retries from the node it names", async () => {
    const ambiguous = await command(["runs", "retry", retried, "--from", "retry/Finish"])
    expect(ambiguous.code).not.toBe(0)
    const message: string = ambiguous.json.message
    expect(message, ambiguous.stderr).toContain(`run ${retried} ran retry/Finish 2 times; name one node: `)
    const nodes = message.slice(message.indexOf("name one node: ") + "name one node: ".length).split(", ")
    expect(nodes).toHaveLength(2)

    const result = await command(["runs", "retry", retried, "--from", nodes[1]!])
    expect(result.code, result.stdout + result.stderr).toBe(0)
    expect(result.json).toMatchObject({ _tag: "Accepted", status: "completed" })
    // Only the last step ran again.
    expect((await calls()).slice(5)).toEqual(["finish b"])
  }, 600_000)

  it("retries from a step named by its action", async () => {
    const result = await command(["runs", "retry", retried, "--from", "retry/Work", "--wait"])
    expect(result.code, result.stdout + result.stderr).toBe(0)
    expect(result.json).toMatchObject({ _tag: "Accepted", status: "completed" })
    expect((await calls()).slice(6)).toEqual(["work", "finish a", "finish b"])
  }, 600_000)
})
