import * as Scheduler from "@smthrs/triggers/Scheduler"
import * as SqlTriggerStore from "@smthrs/triggers/SqlTriggerStore"
import * as TriggerStore from "@smthrs/triggers/TriggerStore"
import { Effect, Layer, Option } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
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

  it("refuses an unknown trigger and queues a manual occurrence at the current time by default", async () => {
    const directory = await root()
    for (const verb of ["show", "fire", "enable"]) {
      const missing = await serve(directory, [verb, "absent"])
      expect(missing.code).toBe(1)
      expect(missing.data.message).toBe("Unknown trigger absent")
    }
    await serve(directory, ["register", "daily", "--flow", "check", "--cron", "0 9 * * *"])
    const before = Date.now()
    const fired = await serve(directory, ["fire", "daily"])
    expect(fired.code, fired.output).toBe(0)
    expect(fired.data.occurrence).toBeGreaterThanOrEqual(before)
    expect(fired.data.occurrence).toBeLessThanOrEqual(Date.now())
    expect(fired.data.idempotencyKey).toBe(Scheduler.idempotencyKey("daily", fired.data.occurrence))
  })

  it("names a stored registration it cannot decode instead of listing around it", async () => {
    const directory = await root()
    await serve(directory, ["register", "daily", "--flow", "check", "--cron", "0 9 * * *"])
    await serve(directory, ["register", "weekly", "--flow", "check", "--cron", "0 9 * * 1"])
    await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE flows_triggers SET input_json = '{not json' WHERE trigger_id = 'weekly'`
      }).pipe(Effect.provide(databaseLayer(directory)))
    )
    const listed = await serve(directory, ["list"])
    expect(listed.code).toBe(1)
    expect(listed.output).toContain("weekly")
    expect((await serve(directory, ["show", "daily"])).code).toBe(0)
  })

  it("shows the active run a scheduler launched, with no approval card for a non-plan run", async () => {
    const directory = await root()
    await serve(directory, ["register", "daily", "--flow", "check", "--cron", "0 9 * * *"])
    await serve(directory, ["fire", "daily", "--occurrence", "1000"])
    // The launched run stays active, so the trigger keeps holding it.
    const runner = Scheduler.layerNoopRunner({
      start: () => Effect.succeed("run-1"),
      inspect: () => Effect.succeed("active")
    })
    const layer = SqlTriggerStore.layer.pipe(Layer.provide(databaseLayer(directory)))
    await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        yield* (yield* Scheduler.make()).runOnce
      })).pipe(Effect.provide([runner, layer]))
    )
    expect((await serve(directory, ["show", "daily"])).data).toMatchObject({
      trigger: { id: "daily" },
      activeRun: "run-1",
      activePlan: null
    })
  })

  it("polls the durable store until its host aborts the scheduler", async () => {
    const directory = await root()
    const controller = new AbortController()
    let code: number | undefined
    const served = createTriggersCli({ signal: controller.signal }).serve(
      ["serve", "--root", directory, "--poll-interval-ms", "20", "--json"],
      {
        exit: (value) => {
          code = value
        },
        stdout: () => {}
      }
    )
    const heartbeat = () =>
      withTriggers(
        { root: directory },
        Effect.gen(function*() {
          return yield* (yield* TriggerStore.TriggerStore).lastHeartbeat()
        })
      )
    const deadline = Date.now() + 30_000
    while (Option.isNone(await heartbeat())) {
      expect(Date.now()).toBeLessThan(deadline)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(code).toBeUndefined()
    controller.abort()
    await served
    const stopped = await heartbeat()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(await heartbeat()).toEqual(stopped)
  })
})
