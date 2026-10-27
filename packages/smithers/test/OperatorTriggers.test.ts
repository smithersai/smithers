import * as Scheduler from "@smthrs/triggers/Scheduler"
import * as SqlTriggerStore from "@smthrs/triggers/SqlTriggerStore"
import * as TriggerStore from "@smthrs/triggers/TriggerStore"
import { Effect, Layer, Option } from "effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { databaseLayer } from "../src/operator/Store.ts"
import { createTriggersCli, withTriggers } from "../src/operator/Triggers.ts"

const directories: Array<string> = []
afterAll(async () => {
  await Promise.all(directories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})
const root = async () => {
  const directory = await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-trigger-cli-"))
  directories.push(directory)
  return directory
}
const serve = async (root: string, args: ReadonlyArray<string>) => {
  let code = 0
  let output = ""
  await createTriggersCli().serve([...args, "--root", root, "--json"], {
    exit: (value) => {
      code = value
    },
    stdout: (value) => {
      output += value
    }
  })
  return { code, output, data: JSON.parse(output) }
}

describe("trigger CLI", () => {
  it("reports an unexpected declaration read failure without registering a trigger", async () => {
    const directory = await root()
    await Fs.symlink("loop.json", Path.join(directory, "loop.json"))
    const result = await serve(directory, ["register", "daily", "--file", "loop.json"])
    expect(result.code).toBe(1)
    expect(result.data.code).toBe("operator_failed")
    expect(result.data.message).toContain("Something went wrong on our side")
    expect((await serve(directory, ["list"])).data).toEqual([])
  })

  it("classifies invalid input JSON and missing or invalid declaration files as user errors", async () => {
    const directory = await root()
    await Fs.writeFile(Path.join(directory, "invalid.json"), "{not json")
    for (const flags of [["--input", "{not json"], ["--file", "nope.json"], ["--file", "invalid.json"]]) {
      const result = await serve(directory, ["register", "daily", "--flow", "check", "--cron", "0 9 * * *", ...flags])
      expect(result.code).toBe(1)
      expect(result.data.message).toContain(flags[0])
      if (flags[0] === "--file") expect(result.data.message).toContain(flags[1])
      expect(result.output).not.toContain("Something went wrong on our side")
    }
    expect((await serve(directory, ["list"])).data).toEqual([])
  })

  it("persists registrations and enablement across command invocations", async () => {
    const directory = await root()
    const registered = await serve(directory, [
      "register",
      "daily",
      "--flow",
      "check",
      "--cron",
      "0 9 * * *",
      "--timezone",
      "UTC"
    ])
    expect(registered.code, registered.output).toBe(0)
    expect((await serve(directory, ["show", "daily"])).data).toMatchObject({
      trigger: { id: "daily" },
      activeRun: null,
      activePlan: null
    })
    expect((await serve(directory, ["list"])).data).toMatchObject([{ id: "daily", enabled: true }])
    expect((await serve(directory, ["disable", "daily"])).data).toMatchObject({ enabled: false, revision: 2 })
    expect((await serve(directory, ["fire", "daily"])).code).toBe(1)
    expect((await serve(directory, ["enable", "daily"])).data).toMatchObject({ enabled: true, revision: 3 })
    const fired = await serve(directory, ["fire", "daily", "--occurrence", "1000"])
    expect(fired.data).toMatchObject({ queued: true, idempotencyKey: "daily:1970-01-01T00:00:01.000Z" })
    const pending = await withTriggers(
      { root: directory },
      Effect.gen(function*() {
        return (yield* (yield* TriggerStore.TriggerStore).inspect("daily")).pendingAt
      })
    )
    expect(pending).toBe(1000)
  })

  it("refuses invalid schedules and mismatched file IDs", async () => {
    const directory = await root()
    expect((await serve(directory, ["register", "bad", "--flow", "check", "--cron", "not cron"])).code).toBe(1)
    await Fs.writeFile(
      Path.join(directory, "trigger.json"),
      JSON.stringify({ id: "actual", flowId: "check", input: {}, cron: "0 9 * * *", enabled: true })
    )
    expect((await serve(directory, ["register", "different", "--file", "trigger.json"])).code).toBe(1)
    expect((await serve(directory, ["list"])).data).toEqual([])
  })

  it("dispatches a manually queued occurrence once through the scheduler", async () => {
    const directory = await root()
    await serve(directory, ["register", "daily", "--flow", "check", "--cron", "0 9 * * *"])
    await serve(directory, ["fire", "daily", "--occurrence", "1000"])
    const launches: Array<string> = []
    const runner = Scheduler.layerNoopRunner({
      start: (input) =>
        Effect.sync(() => {
          launches.push(input.idempotencyKey)
          return "run-1"
        })
    })
    const layer = SqlTriggerStore.layer.pipe(Layer.provide(databaseLayer(directory)))
    await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const scheduler = yield* Scheduler.make()
        yield* scheduler.runOnce
        yield* scheduler.runOnce
      })).pipe(Effect.provide([runner, layer]))
    )
    expect(launches).toEqual(["daily:1970-01-01T00:00:01.000Z"])
  })
})
