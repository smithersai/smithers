/**
 * `smthrs alerts` against a real project: a temporary directory, the project's
 * durable journal under `.flows/`, and a real loopback server answering the
 * way Telegram's Bot API and Resend do. Nothing intercepts a request.
 */
import * as Audience from "@smthrs/build-cli/Audience"
import type { RuntimeConfig } from "@smthrs/build-cli/Cli"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { makeCli } from "../src/Cli.ts"

const BOT_TOKEN = "123456:SYNTHETIC_BOT_TOKEN"
const EMAIL_KEY = "re_SYNTHETIC_EMAIL_KEY"
const run = "probe-owner"

/** One request the provider received. */
interface Received {
  readonly path: string
  readonly body: { readonly text?: string; readonly subject?: string }
}

let server: Server
let origin: string
let received: Array<Received> = []
let statuses: Array<number> = []
const directories: Array<string> = []

beforeAll(async () => {
  server = createServer((request, response) => {
    let raw = ""
    request.setEncoding("utf8")
    request.on("data", (chunk: string) => (raw += chunk))
    request.on("end", () => {
      received.push({ path: request.url ?? "", body: JSON.parse(raw) })
      const status = statuses.shift() ?? 200
      response.writeHead(status, { "content-type": "application/json" })
      response.end(JSON.stringify(
        status === 200 ? { ok: true, id: `email-${received.length}`, result: { message_id: received.length } } : {
          ok: false
        }
      ))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })))
})

beforeEach(() => {
  received = []
  statuses = []
})

/** A fresh project directory, with `.smithers/alerts.json` when `config` is given. */
const project = async (config?: unknown) => {
  const root = await mkdtemp(join(tmpdir(), "smthrs-alerts-"))
  directories.push(root)
  await mkdir(join(root, ".smithers"))
  if (config !== undefined) {
    await writeFile(
      join(root, ".smithers", "alerts.json"),
      typeof config === "string" ? config : JSON.stringify(config)
    )
  }
  return root
}

const telegramProject = () =>
  project({
    defaults: { owner: "oncall" },
    probes: { "site-freshness": { afterMs: 0, severity: "critical" } },
    telegram: { chatId: "-1001234567890", url: origin }
  })

/** Runs one command line through the public command tree and collects what it printed. */
const invoke = async (
  args: ReadonlyArray<string>,
  environment: Record<string, string> = { SMITHERS_ALERT_TELEGRAM_TOKEN: BOT_TOKEN },
  terminal = false
) => {
  const result = { stdout: "", stderr: "", codes: [] as Array<number> }
  const config: RuntimeConfig = {
    environment,
    stdout: { isTTY: terminal, columns: 80, write: (text) => void (result.stdout += text) },
    stderr: { isTTY: false, columns: 80, write: (text) => void (result.stderr += text) },
    exit: (code) => void result.codes.push(code)
  }
  const presentation = Audience.fromArguments([...args], {
    env: environment,
    stdout: terminal,
    stderr: false
  })
  await makeCli({ ...config, presentation }).serve(Audience.incurArguments([...args], presentation), {
    env: environment,
    stdout: (text) => void (result.stdout += text),
    exit: (code) => void result.codes.push(code)
  })
  return result
}

/** One command's JSON document; the command must have exited 0. */
const json = async (args: ReadonlyArray<string>, environment?: Record<string, string>) => {
  const result = await invoke([...args, "--json"], environment)
  expect(result.codes.filter((code) => code !== 0), result.stdout + result.stderr).toEqual([])
  return JSON.parse(result.stdout)
}

const report = (root: string, state: "failing" | "ok", environment?: Record<string, string>) =>
  json([
    "alerts",
    "report",
    "--root",
    root,
    "--run",
    run,
    "--probe",
    "site-freshness",
    "--state",
    state,
    "--summary",
    "site lags main by 979 minutes"
  ], environment)

const list = (root: string) => json(["alerts", "list", "--root", root, "--run", run])

describe("smthrs alerts", () => {
  it("pages once for a probe that keeps failing, until it is acknowledged, and again after it recovers", async () => {
    const root = await telegramProject()

    const first = await report(root, "failing")
    const second = await report(root, "failing")
    const third = await report(root, "failing")

    expect(received).toHaveLength(1)
    expect(received[0]!.path).toBe(`/bot${BOT_TOKEN}/sendMessage`)
    const id = /^Alert: (.+)$/mu.exec(received[0]!.body.text!)![1]!
    expect(first).toMatchObject({
      runId: run,
      probe: "site-freshness",
      state: "failing",
      destination: "telegram",
      delivered: [{ alertId: id, condition: "site-freshness", severity: "critical" }],
      failed: [],
      refused: [],
      suppressed: []
    })
    for (const repeated of [second, third]) {
      expect(repeated).toMatchObject({ delivered: [], suppressed: [{ alertId: id }] })
    }
    expect(JSON.stringify([first, second, third])).not.toContain(BOT_TOKEN)

    expect((await list(root)).alerts).toEqual([
      expect.objectContaining({
        alertId: id,
        condition: "site-freshness",
        state: "delivered",
        severity: "critical",
        summary: "site lags main by 979 minutes"
      })
    ])

    const taken = await json(["alerts", "ack", "--root", root, "--run", run, "--id", id, "--by", "will"])
    expect(taken).toMatchObject({ runId: run, alertId: id, by: "will", acknowledged: true })
    expect((await list(root)).alerts).toEqual([
      expect.objectContaining({ alertId: id, state: "acknowledged", acknowledgedBy: "will" })
    ])

    expect(await report(root, "failing")).toMatchObject({ delivered: [], suppressed: [{ alertId: id }] })
    expect(received).toHaveLength(1)

    expect(await report(root, "ok")).toMatchObject({ delivered: [], suppressed: [] })
    expect((await list(root)).alerts).toEqual([])
    const reopened = await report(root, "failing")
    expect(received).toHaveLength(2)
    const reopenedId = /^Alert: (.+)$/mu.exec(received[1]!.body.text!)![1]!
    expect(reopenedId).not.toBe(id)
    expect(reopened.delivered).toEqual([expect.objectContaining({ alertId: reopenedId })])
  })

  it("acknowledges as the OS user by default and refuses an id that is not open", async () => {
    const root = await telegramProject()
    await report(root, "failing")
    const [{ alertId }] = (await list(root)).alerts

    const unknown = await invoke(["alerts", "ack", "--root", root, "--run", run, "--id", "alert:nothing", "--json"])
    expect(unknown.codes).toEqual([1])
    expect(unknown.stdout + unknown.stderr).toContain("No open alert on run probe-owner has the id alert:nothing")

    expect(await json(["alerts", "ack", "--root", root, "--run", run, "--id", alertId])).toMatchObject({
      by: userInfo().username,
      acknowledged: true
    })
  })

  it("repeats the page under the same id while nobody acknowledges it", async () => {
    const root = await project({
      probes: { "site-freshness": { afterMs: 0, repeatMs: 1 } },
      telegram: { chatId: "-1001234567890", url: origin }
    })
    const first = await report(root, "failing")
    await new Promise((resolve) => setTimeout(resolve, 20))
    const repeated = await report(root, "failing")

    expect(received).toHaveLength(2)
    expect(received[1]!.body.text).toMatch(/^\[warning\] site-freshness \(reminder \d+\)/u)
    expect(repeated.delivered).toEqual([
      expect.objectContaining({ alertId: first.delivered[0].alertId, reminder: expect.any(Number) })
    ])
  })

  it("reports a provider that refuses the page and sends it on the next report", async () => {
    const root = await telegramProject()
    statuses = [500]

    const refused = await report(root, "failing")
    expect(refused).toMatchObject({ delivered: [], failed: [{ condition: "site-freshness" }] })
    expect((await list(root)).alerts).toEqual([expect.objectContaining({ state: "raised" })])

    expect(await report(root, "failing")).toMatchObject({ delivered: [{ condition: "site-freshness" }] })
    expect(received).toHaveLength(2)
  })

  it("records without paging when no destination is configured, and pages once one is", async () => {
    const root = await project()

    const recorded = await report(root, "failing", {})
    expect(recorded).toMatchObject({
      destination: "none",
      note: "no destination configured; recorded only",
      delivered: []
    })
    expect((await list(root)).alerts).toEqual([
      expect.objectContaining({ condition: "site-freshness", state: "raised", severity: "warning" })
    ])

    await writeFile(
      join(root, ".smithers", "alerts.json"),
      JSON.stringify({ telegram: { chatId: "-1001234567890", url: origin } })
    )
    const unpaged = await report(root, "failing", {})
    expect(unpaged).toMatchObject({
      destination: "none",
      note: "telegram is configured but SMITHERS_ALERT_TELEGRAM_TOKEN is not set; recorded only"
    })
    expect(received).toEqual([])

    expect(await report(root, "failing")).toMatchObject({ destination: "telegram", delivered: [{}] })
    expect(received).toHaveLength(1)
  })

  it("sends email when only email is configured", async () => {
    const root = await project({
      email: { to: ["oncall@example.com"], from: "alerts@example.com", url: origin }
    })

    const sent = await report(root, "failing", { SMITHERS_ALERT_EMAIL_API_KEY: EMAIL_KEY })
    expect(sent).toMatchObject({ destination: "email", delivered: [{ condition: "site-freshness" }] })
    expect(received.map((request) => [request.path, request.body.subject])).toEqual([
      ["/emails", "[warning] site-freshness"]
    ])

    await writeFile(
      join(root, ".smithers", "alerts.json"),
      JSON.stringify({ email: { to: ["oncall@example.com"], from: "alerts@example.com", url: origin } })
    )
    expect(
      await json([
        "alerts",
        "report",
        "--root",
        root,
        "--run",
        run,
        "--probe",
        "disk-space",
        "--state",
        "failing"
      ], {})
    ).toMatchObject({
      destination: "none",
      note: "email is configured but SMITHERS_ALERT_EMAIL_API_KEY is not set; recorded only"
    })
  })

  it("lists every probe the run has reported, configured or not", async () => {
    const root = await project({ probes: { "site-freshness": { afterMs: 3_600_000 } } })
    await report(root, "failing", {})
    await json(["alerts", "report", "--root", root, "--run", run, "--probe", "disk-space", "--state", "failing"], {})

    // `site-freshness` waits an hour before it raises anything.
    expect((await list(root)).alerts.map((alert: { condition: string }) => alert.condition)).toEqual(["disk-space"])
  })

  it.each([
    ["{", "is not valid JSON"],
    [{ probes: { "site-freshness": { afterMs: -1 } } }, "afterMs"],
    [{ telegram: { chatid: "-1001234567890" } }, "chatid"],
    [{ telegram: { chatId: "-1001234567890", url: "https://api.example.com" } }, "url"],
    [{ email: { to: [], from: "alerts@example.com" } }, "to"]
  ])("refuses a bad .smithers/alerts.json as a usage error naming the field (%j)", async (config, field) => {
    const root = await project(config)
    const result = await invoke([
      "alerts",
      "report",
      "--root",
      root,
      "--run",
      run,
      "--probe",
      "site-freshness",
      "--state",
      "failing",
      "--json"
    ])
    expect(result.codes).toEqual([2])
    expect(result.stdout + result.stderr).toContain(".smithers/alerts.json")
    expect(result.stdout + result.stderr).toContain(field)
    expect(received).toEqual([])
  })

  it("refuses an unreadable .smithers/alerts.json", async () => {
    const root = await project()
    await mkdir(join(root, ".smithers", "alerts.json"))
    const result = await invoke(["alerts", "list", "--root", root, "--run", run, "--json"])
    expect(result.codes).toEqual([2])
    expect(result.stdout + result.stderr).toContain("Cannot read .smithers/alerts.json")
  })

  it("refuses a state other than failing or ok before it opens the journal", async () => {
    const root = await project()
    const result = await invoke([
      "alerts",
      "report",
      "--root",
      root,
      "--run",
      run,
      "--probe",
      "site-freshness",
      "--state",
      "broken",
      "--json"
    ])
    expect(result.codes.some((code) => code !== 0)).toBe(true)
    expect(result.stdout + result.stderr).toContain("state")
  })

  it("prints what was paged and what is open for a person", async () => {
    const root = await telegramProject()
    const human = (args: ReadonlyArray<string>) =>
      invoke([...args, "--root", root, "--run", run, "--audience", "human", "--silent"], undefined, true)

    const reported = await human(["alerts", "report", "--probe", "site-freshness", "--state", "failing"])
    const id = /^Alert: (.+)$/mu.exec(received[0]!.body.text!)![1]!
    expect(reported.stdout).toBe([
      "alerts report",
      "Recorded site-freshness failing on probe-owner.",
      `Delivered by telegram: site-freshness ${id}`,
      "Next:",
      `smthrs alerts list --run probe-owner --root ${root}`,
      ""
    ].join("\n"))
    const since = new Date(Number(id.split(":").at(-1))).toISOString()
    expect((await human(["alerts", "list"])).stdout).toBe(
      `alerts list\nsite-freshness  delivered  -  ${since}  ${id}\n`
    )
    expect((await human(["alerts", "ack", "--id", id, "--by", "will"])).stdout).toContain(`will acknowledged ${id}.`)
    expect((await human(["alerts", "report", "--probe", "site-freshness", "--state", "failing"])).stdout)
      .toContain(`Already paged or acknowledged: site-freshness ${id}`)
    expect((await human(["alerts", "report", "--probe", "site-freshness", "--state", "ok"])).stdout)
      .toContain("Recorded site-freshness ok on probe-owner.")
    expect((await human(["alerts", "list"])).stdout).toBe("alerts list\nNo open alerts on probe-owner.\n")
  })
})
