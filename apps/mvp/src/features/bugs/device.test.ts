// Bug reports on real devices (docs/features/bugs.md): the browser's own layer on Node devices whose engines lead,
// against ChatApi's real handler over the compose Postgres and Electric. A Member presses Send in the bug plugin's
// form, built from `PluginHost` alone: `app/bug/report` asks the tab what it showed, ChatApi files the row, Electric
// brings it back, and the form says Sent. The Admin sees every report and reads them with `app/bug/list`; a Member
// sees only their own and is refused the read.
import { Effect } from "effect"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { BugsTab, Report } from "../../../plugins/bugs/src/tab"
import type * as Actor from "../../../worker/Actor.ts"
import { FlowDispatch } from "../../flows/dispatch"
import { PluginsUi } from "../../plugins/ui"
import { asPerson, type DeviceOptions, nodeDevice, openTab, openTestApp, TestChatApi } from "../../test/chatApi"
import { bugAlertId } from "./contract"
import { BugRefused } from "./flows"

const runtimes: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose()
})

const until = (assertion: () => void | Promise<void>, timeout = 60_000) =>
  vi.waitFor(assertion, { timeout, interval: 20 })

const admin: Actor.Actor = { subject: { kind: "person", id: "person-bug-admin" }, role: "admin", login: "bug-admin" }

/** A router a test drives: the page now, and every page it shows, heard as main.tsx hears TanStack Router. */
const router = (first: string) => {
  let now = first
  const listeners = new Set<(path: string) => void>()
  return {
    host: {
      pathname: () => now,
      pages: (listener: (path: string) => void) => {
        listeners.add(listener)
        listener(now)
        return () => void listeners.delete(listener)
      },
    } satisfies Partial<DeviceOptions>,
    show: (path: string) => {
      now = path
      for (const listener of listeners) listener(path)
    },
  }
}

/** A device on `api`, its plugin host and dispatch, and the bug plugin's tab. */
const openDevice = async (api: TestChatApi["Service"], options: DeviceOptions = {}) => {
  const device = nodeDevice({ agent: api, ...options })
  const runtime = openTab(api, { host: device })
  runtimes.push(runtime)
  const plugins = await runtime.runPromise(Effect.service(PluginsUi))
  const flows = await runtime.runPromise(Effect.service(FlowDispatch))
  const tab = (await plugins.actions.tab("bugs")) as BugsTab
  return {
    plugins,
    device,
    tab,
    reports: () => tab.queries.reports.current() as ReadonlyArray<Report>,
    sending: () => tab.queries.sending.current(),
    list: () => runtime.runPromise(flows.dispatch("app/bug/list", {}, { door: "button" })),
  }
}

describe("a bug report on a real device", { timeout: 120_000 }, () => {
  test("a Member's Send files it with the page before the form and comes back Sent; only an Admin reads every report", async () => {
    const root = openTestApp({ answers: false }, { people: { admin } })
    runtimes.push(root)
    const api = await root.runPromise(Effect.service(TestChatApi))
    const pages = router("/octocat/Spoon-Knife/issues")
    const member = await openDevice(api, {
      ...pages.host,
      build: "38569d55ad79",
      screen: () => ({ browser: "Test/1.0", viewport: "1280x800" }),
    })

    // The plugin's components load by the names its manifest renders.
    expect(Object.keys(await member.plugins.actions.components("bugs")).sort()).toEqual(["Inbox", "NavButton", "Report"])

    // The header's entry opens the form, and the form is where the person writes.
    member.tab.actions.report()
    await until(() => expect(member.device.navigated).toContain("/app/bugs/report"))
    pages.show("/app/bugs/report")

    // Only spaces send nothing.
    member.tab.actions.send("   ")
    expect(member.sending()).toEqual({ status: "idle" })

    member.tab.actions.send("  The run page stayed blank after Retry  ")
    expect(member.sending().status).toBe("sending")
    await until(() => expect(member.sending().status).toBe("sent"))
    const sent = member.sending() as { readonly status: "sent"; readonly report: Report }
    expect(sent.report).toMatchObject({
      what: "The run page stayed blank after Retry",
      route: "/octocat/Spoon-Knife/issues",
      repo: "octocat/Spoon-Knife",
      build: "38569d55ad79",
      browser: "Test/1.0",
      viewport: "1280x800",
      reporterRole: "member",
      // The form's Send runs as a flow for the person (door `view`, decision 0017 slice 0).
      actedBy: "flow",
    })
    // The tab's latest runs: at least the form's own navigation, with its trace.
    expect(sent.report.runs.length).toBeGreaterThan(0)
    const github = new URL(sent.report.github)
    expect(github.pathname).toBe("/octocat/Spoon-Knife/issues/new")
    expect(github.searchParams.get("body")).toContain("Page: issues")
    // ChatApi started the Admins' notice for it, once.
    expect(api.bugs.starts).toEqual([
      { flow: "ops/BugReport", executionId: bugAlertId(sent.report.id), payload: { id: sent.report.id } },
    ])

    // A Member reads only their own reports, and the read route refuses them.
    const refused = await member.list()
    expect(refused).toMatchObject({ _tag: "Failed", error: new BugRefused({ status: 403, code: "forbidden" }) })

    // The Admin sees every report, newest first, and reads it with `app/bug/list`.
    const adminApi = asPerson(api, "admin")
    const boss = await openDevice(adminApi)
    await until(() => expect(boss.reports().map((row) => row.id)).toContain(sent.report.id))
    const listed = await boss.list()
    expect(listed._tag).toBe("Done")
    const reports = (listed as { readonly value: { readonly reports: ReadonlyArray<{ readonly id: string }> } }).value.reports
    expect(reports.map((row) => row.id)).toContain(sent.report.id)

    // The Admin's own report reaches the Admin, never the Member.
    boss.tab.actions.send("Admins report too")
    await until(() => expect(boss.sending().status).toBe("sent"))
    const own = (boss.sending() as { readonly report: Report }).report
    expect(own).toMatchObject({ reporterLogin: "bug-admin", reporterRole: "admin", build: "dev" })
    await until(() => expect(boss.reports()[0]!.id).toBe(own.id))
    expect(member.reports().map((row) => row.id)).toEqual([sent.report.id])
  })
})
