import * as Scheduler from "@smthrs/triggers/Scheduler"
import { TriggerError } from "@smthrs/triggers/TriggerError"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as TargetRuns from "../src/operator/TargetRuns.ts"
import { bareProject, command, removeWorkspaces, until, workspace } from "./support/target-workspace.ts"

afterAll(removeWorkspaces)

/** One scheduler process's runner over a project, and the end of that process. */
const host = (
  root: string,
  commandLayer: Layer.Layer<TargetRuns.TargetCommand>,
  options: { readonly leaseMs?: number; readonly flows?: Layer.Layer<Scheduler.Runner> } = {}
) =>
  Effect.runPromise(Effect.gen(function*() {
    const scope = yield* Scope.make()
    const context = yield* Layer.buildWithScope(
      TargetRuns.layer(root, { leaseMs: options.leaseMs ?? 300 }).pipe(
        Layer.provide([commandLayer, options.flows ?? Scheduler.layerNoopRunner()])
      ),
      scope
    )
    const runner = Context.get(context, Scheduler.Runner)
    return {
      start: (input: Scheduler.StartInput) => Effect.runPromise(runner.start(input)),
      inspect: (handle: string) => Effect.runPromise(runner.inspect(handle)),
      cancel: (handle: string) => Effect.runPromise(runner.cancel(handle)),
      stop: () => Effect.runPromise(Scope.close(scope, Exit.void))
    }
  }))

/** A command that never answers: the fault of a host that hangs. */
const hung = Layer.succeed(TargetRuns.TargetCommand)({ run: () => Effect.never })

const launch = (key: string, run: ReadonlyArray<string>): Scheduler.StartInput => ({
  flowId: TargetRuns.flowId,
  input: { run },
  idempotencyKey: key
})
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
/** The process a `slow` target runs, once the target has started. */
const slowPid = async (root: string) =>
  Number(await until(() => readFile(join(root, "pid"), "utf8").catch(() => ""), (text) => text.trim() !== ""))

const census =
  `const census = S.Shell.Run({ shell: "echo counted >> census.log", sandbox: "none" })\nexport const Package = S.Package({ targets: { census } })`
const slow =
  `const slow = S.Shell.Run({ shell: "echo $$ > pid; exec sleep 300", sandbox: "none" })\nexport const Package = S.Package({ targets: { slow } })`

describe("scheduled target runs", () => {
  it("takes over a run whose host died and runs it again", async () => {
    const root = await workspace(census)
    const dead = await host(root, hung, { leaseMs: 4_000 })
    const handle = await dead.start(launch("nightly:1", ["//:census"]))
    expect(handle).toBe("target-run:nightly:1")
    expect(await dead.start(launch("nightly:1", ["//:census"]))).toBe(handle)
    expect(await dead.inspect(handle)).toBe("active")
    await dead.stop()

    const successor = await host(root, command(root))
    try {
      // The dead host's lease still stands, so its run is left alone.
      expect(await successor.inspect(handle)).toBe("active")
      expect(await TargetRuns.inspectRun(root, handle)).toMatchObject({ status: "running", attempts: 1 })
      expect(await until(() => successor.inspect(handle), (state) => state !== "active")).toBe("completed")
      expect(await TargetRuns.inspectRun(root, handle)).toMatchObject({
        launch: { run: ["//:census"] },
        status: "completed",
        exitCode: 0,
        error: null,
        attempts: 2,
        log: ".flows/logs/target-run_nightly_1.log"
      })
      expect(await readFile(join(root, "census.log"), "utf8")).toBe("counted\n")
    } finally {
      await successor.stop()
    }
  }, 120_000)

  it("stops its command when the run is cancelled, from this process or another", async () => {
    const root = await workspace(slow)
    const owner = await host(root, command(root))
    const other = await host(root, hung)
    try {
      const local = await owner.start(launch("local:1", ["//:slow"]))
      const first = await slowPid(root)
      expect(await owner.inspect(local)).toBe("active")
      await owner.cancel(local)
      expect(await owner.inspect(local)).toBe("cancelled")
      expect(await until(async () => alive(first), (running) => !running)).toBe(false)

      await writeFile(join(root, "pid"), "")
      const remote = await owner.start(launch("remote:1", ["//:slow"]))
      const second = await slowPid(root)
      await other.cancel(remote)
      expect(await other.inspect(remote)).toBe("cancelled")
      // The owner learns of the cancellation at its next lease renewal.
      expect(await until(async () => alive(second), (running) => !running)).toBe(false)
      expect(await TargetRuns.inspectRun(root, remote)).toMatchObject({ status: "cancelled", exitCode: null })
    } finally {
      await owner.stop()
      await other.stop()
    }
  }, 120_000)

  it("records a command that cannot start or is killed as a failed run", async () => {
    const root = await bareProject()
    const killer = join(root, "killed.mjs")
    await writeFile(killer, "process.kill(process.pid, 'SIGKILL')\n")
    const cases = [
      [TargetRuns.layerCommand({ execPath: join(root, "no-such-node") }), "Could not start smthrs target"],
      [TargetRuns.layerCommand({ entry: killer }), "smthrs target was stopped by SIGKILL"],
      [
        Layer.succeed(TargetRuns.TargetCommand)({
          run: () => Effect.fail(new TriggerError({ code: "runner", message: "no build on this host" }))
        }),
        "no build on this host"
      ]
    ] as const
    for (const [index, [commandLayer, message]] of cases.entries()) {
      const failing = await host(root, commandLayer)
      try {
        const handle = await failing.start(launch(`broken:${index}`, ["//:census"]))
        expect(await until(() => failing.inspect(handle), (state) => state !== "active")).toBe("failed")
        expect(await TargetRuns.inspectRun(root, handle)).toMatchObject({
          status: "failed",
          exitCode: null,
          error: message
        })
      } finally {
        await failing.stop()
      }
    }
  }, 60_000)

  it("refuses an input that is not a list of labels and knows no other handle", async () => {
    const root = await bareProject()
    expect(await TargetRuns.inspectRun(root, "target-run:before-any-scheduler")).toBeNull()
    const runner = await host(root, hung)
    try {
      for (const input of [{ run: [] }, { run: ["--write"] }, { run: ["//:a"], refresh: ["b"] }, "//:a"]) {
        const refused = await runner.start({ flowId: TargetRuns.flowId, input, idempotencyKey: "bad:1" }).catch((
          error: unknown
        ) => error)
        expect(String(refused)).toContain("Could not start the scheduled target run")
      }
      expect(await runner.inspect("target-run:absent")).toBe("missing")
      await runner.cancel("target-run:absent")
      expect(await TargetRuns.inspectRun(root, "target-run:absent")).toBeNull()
      expect(await TargetRuns.inspectRun(root, "run-1")).toBeNull()
      expect(TargetRuns.isHandle("run-1")).toBe(false)
    } finally {
      await runner.stop()
    }
  })

  it("leaves every other flow to the runner it wraps", async () => {
    const root = await bareProject()
    const calls: Array<string> = []
    const runner = await host(root, hung, {
      flows: Scheduler.layerNoopRunner({
        start: (input) => Effect.sync(() => (calls.push(`start ${input.flowId}`), "run-1")),
        inspect: (handle) => Effect.sync(() => (calls.push(`inspect ${handle}`), "active" as const)),
        cancel: (handle) => Effect.sync(() => void calls.push(`cancel ${handle}`))
      })
    })
    try {
      expect(await runner.start({ flowId: "check", input: {}, idempotencyKey: "daily:1" })).toBe("run-1")
      expect(await runner.inspect("run-1")).toBe("active")
      await runner.cancel("run-1")
      expect(calls).toEqual(["start check", "inspect run-1", "cancel run-1"])
    } finally {
      await runner.stop()
    }
  })
})
