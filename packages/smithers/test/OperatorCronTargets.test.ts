import * as TriggerStore from "@smthrs/triggers/TriggerStore"
import { Effect } from "effect"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { createTriggersCli, withTriggers } from "../src/operator/Triggers.ts"
import { bareProject, command, declare, removeWorkspaces, until, workspace } from "./support/target-workspace.ts"

afterAll(removeWorkspaces)

const serve = async (root: string, args: ReadonlyArray<string>, signal?: AbortSignal) => {
  let code = 0
  let output = ""
  await createTriggersCli({ signal, targets: { command: command(root), leaseMs: 600 } }).serve(
    [...args, "--root", root, "--json"],
    {
      exit: (value) => {
        code = value
      },
      stdout: (value) => {
        output += value
      }
    }
  )
  return { code, output, data: output === "" ? undefined : JSON.parse(output) }
}

/** Runs the scheduler host while `body` runs, then stops it. */
const serving = async <A>(root: string, body: () => Promise<A>): Promise<A> => {
  const controller = new AbortController()
  const served = serve(root, ["serve", "--poll-interval-ms", "20"], controller.signal)
  try {
    return await body()
  } finally {
    controller.abort()
    await served
  }
}

const history = (root: string) =>
  withTriggers(
    { root },
    Effect.gen(function*() {
      return (yield* (yield* TriggerStore.TriggerStore).history()).items
    })
  )
const settled = (root: string) =>
  until(() => history(root), (items) => items.some((item) => item.outcome === "completed" || item.outcome === "failed"))

const census = `const census = S.Shell.Run({ shell: "echo counted >> census.log", sandbox: "none" })`
const nightly = (schedule: string) =>
  `${census}
export const Package = S.Package({ targets: { census, nightly: S.Cron({ schedule: ${
    JSON.stringify(schedule)
  }, run: [census] }) } })`

describe("S.Cron targets", () => {
  it("serve registers a PACKAGE.ts schedule and runs its target with no cron line", async () => {
    const root = await workspace(nightly("*/10 * * * *"))
    await serving(root, async () => {
      const listed = await until(() => serve(root, ["list"]), (result) => result.data?.length === 1)
      expect(listed.data).toMatchObject([{
        id: "//:nightly",
        flowId: "system/target-run",
        cron: "*/10 * * * *",
        input: { run: ["//:census"], declaredBy: "//:nightly" },
        enabled: true
      }])
      // The schedule's next occurrence is up to ten minutes away; a manual
      // occurrence takes the same path through the scheduler.
      expect((await serve(root, ["fire", "//:nightly", "--occurrence", "1000"])).code).toBe(0)
      expect(await settled(root)).toMatchObject([{ triggerId: "//:nightly", outcome: "completed" }])
      expect(await readFile(join(root, "census.log"), "utf8")).toBe("counted\n")
    })
  }, 120_000)

  it("runs refresh targets before run targets and shows the run while it is active", async () => {
    const root = await workspace(
      `const first = S.Shell.Run({ shell: "echo first >> order.log", sandbox: "none" })
const second = S.Shell.Run({ shell: "sleep 2; echo second >> order.log", sandbox: "none" })
export const Package = S.Package({ targets: { first, second, nightly: S.Cron({ schedule: "0 3 * * *", refresh: [first], run: [second] }) } })`
    )
    expect((await serve(root, ["sync"])).data).toEqual({ registered: ["//:nightly"], unchanged: [], withdrawn: [] })
    await serve(root, ["fire", "//:nightly", "--occurrence", "1000"])
    await serving(root, async () => {
      const shown = await until(
        () => serve(root, ["show", "//:nightly"]),
        (result) => result.data.activeTargetRun !== undefined
      )
      expect(shown.data).toMatchObject({
        activeRun: "target-run://:nightly:1970-01-01T00:00:01.000Z",
        activePlan: null,
        activeTargetRun: {
          launch: { refresh: ["//:first"], run: ["//:second"] },
          status: "running",
          exitCode: null,
          attempts: 1
        }
      })
      expect(await settled(root)).toMatchObject([{ outcome: "completed" }])
      expect(await readFile(join(root, "order.log"), "utf8")).toBe("first\nsecond\n")
      expect((await serve(root, ["show", "//:nightly"])).data).toMatchObject({ activeRun: null })
    })
  }, 120_000)

  it("records a failing target as a failed occurrence and keeps its output", async () => {
    const root = await workspace(
      `const broken = S.Shell.Run({ shell: "echo census-is-broken; exit 3", sandbox: "none" })
const after = S.Shell.Run({ shell: "echo after >> after.log", sandbox: "none" })
export const Package = S.Package({ targets: { broken, after, nightly: S.Cron({ schedule: "0 3 * * *", refresh: [broken], run: [after] }) } })`
    )
    await serve(root, ["sync"])
    await serve(root, ["fire", "//:nightly", "--occurrence", "1000"])
    await serving(root, async () => {
      const fires = await settled(root)
      expect(fires).toMatchObject([{ triggerId: "//:nightly", outcome: "failed" }])
      expect(fires[0]!.error).toContain("failed")
    })
    const log = await readFile(join(root, ".flows/logs/target-run_nightly_1970-01-01T00_00_01.000Z.log"), "utf8")
    expect(log).toContain("census-is-broken")
    // The refresh failed, so the run labels never started.
    await expect(readFile(join(root, "after.log"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  }, 120_000)

  it("keeps the store in step with the declarations", async () => {
    const root = await workspace(nightly("*/10 * * * *"))
    await serve(root, ["register", "daily", "--flow", "check", "--cron", "0 9 * * *"])
    await serve(root, [
      "register",
      "by-hand",
      "--flow",
      "system/target-run",
      "--cron",
      "0 9 * * *",
      "--input",
      "{\"run\":[\"//:census\"]}"
    ])
    const first = await serve(root, ["sync"])
    expect(first.code, first.output).toBe(0)
    expect(first.data).toEqual({ registered: ["//:nightly"], unchanged: [], withdrawn: [] })
    expect((await serve(root, ["sync"])).data).toEqual({ registered: [], unchanged: ["//:nightly"], withdrawn: [] })
    expect((await serve(root, ["show", "//:nightly"])).data.trigger).toMatchObject({ revision: 1, enabled: true })

    // An operator's disablement outlives a changed declaration.
    await serve(root, ["disable", "//:nightly"])
    await declare(root, nightly("0 4 * * *"))
    expect((await serve(root, ["sync"])).data).toEqual({ registered: ["//:nightly"], unchanged: [], withdrawn: [] })
    expect((await serve(root, ["show", "//:nightly"])).data.trigger).toMatchObject({
      cron: "0 4 * * *",
      enabled: false
    })

    // A removed declaration is disabled once and keeps its registration.
    await serve(root, ["enable", "//:nightly"])
    await declare(root, `${census}\nexport const Package = S.Package({ targets: { census } })`)
    expect((await serve(root, ["sync"])).data).toEqual({ registered: [], unchanged: [], withdrawn: ["//:nightly"] })
    expect((await serve(root, ["sync"])).data).toEqual({ registered: [], unchanged: [], withdrawn: [] })
    expect((await serve(root, ["show", "//:nightly"])).data.trigger).toMatchObject({
      enabled: false,
      input: { withdrawn: true }
    })

    // Declaring it again enables it.
    await declare(root, nightly("0 4 * * *"))
    expect((await serve(root, ["sync"])).data).toEqual({ registered: ["//:nightly"], unchanged: [], withdrawn: [] })
    expect((await serve(root, ["show", "//:nightly"])).data.trigger).toMatchObject({
      enabled: true,
      input: { run: ["//:census"], declaredBy: "//:nightly" }
    })

    // Triggers registered by hand are never touched.
    expect((await serve(root, ["list"])).data).toMatchObject([
      { id: "//:nightly" },
      { id: "by-hand", enabled: true, revision: 1 },
      { id: "daily", enabled: true, revision: 1 }
    ])
  }, 120_000)

  it("refuses a schedule the calendar never satisfies and an entry with no label", async () => {
    const root = await workspace(
      `${census}\nexport const Package = S.Package({ targets: { census, never: S.Cron({ schedule: "0 0 30 2 *", run: [census] }) } })`
    )
    const invalid = await serve(root, ["sync"])
    expect(invalid.code).toBe(1)
    expect(invalid.data.message).toContain("Cron //:never is invalid")
    await declare(
      root,
      `${census}\nexport const Package = S.Package({ targets: { nightly: S.Cron({ schedule: "0 3 * * *", run: [census] }) } })`
    )
    const unlabeled = await serve(root, ["sync"])
    expect(unlabeled.code).toBe(1)
    expect(unlabeled.data.message).toBe("An entry of Cron //:nightly has no label; list it in a Package map")
    expect((await serve(root, ["list"])).data).toEqual([])
  }, 120_000)

  it("registers nothing in a project that is not a build workspace", async () => {
    const root = await bareProject()
    expect((await serve(root, ["sync"])).data).toEqual({ registered: [], unchanged: [], withdrawn: [] })
  })

  it("keeps serving registered schedules when the declarations cannot be read", async () => {
    const root = await workspace(nightly("*/10 * * * *"))
    await serve(root, ["sync"])
    await declare(root, "export const Package = S.Package({ targets: { broken: S.NoSuchRule({}) } })")
    const refused = await serve(root, ["sync"])
    expect(refused.code).toBe(1)
    expect(refused.data.message).toContain("Could not read this project's S.Cron targets")
    await serve(root, ["fire", "//:nightly", "--occurrence", "1000"])
    await serving(root, async () => {
      // The registered schedule still fires; its run then fails on the same broken declaration.
      expect(await settled(root)).toMatchObject([{ triggerId: "//:nightly", outcome: "failed" }])
    })
    expect((await serve(root, ["show", "//:nightly"])).data.trigger).toMatchObject({ enabled: true })
  }, 120_000)
})
