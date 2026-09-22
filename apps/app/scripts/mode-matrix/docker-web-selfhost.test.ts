import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  startPackagedWebSelfhost,
  webSelfhostResources,
  type CommandExecutor,
  type CommandResult
} from "./docker-web-selfhost"

const roots: string[] = []
const revision = "a".repeat(40)
const temporary = (): string => {
  const root = mkdtempSync(join(tmpdir(), "smithers-mode-launcher-"))
  roots.push(root)
  return root
}

afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }) })

describe("packaged web-selfhost launcher", () => {
  const absentInspect = (args: readonly string[]): CommandResult => ({
    exitCode: 1,
    stdout: "",
    stderr: args[1] === "network"
      ? `Error response from daemon: network ${args.at(-1)} not found`
      : `Error: No such ${args[1]}: ${args.at(-1)}`
  })

  test("uses one collision-resistant namespace for every disposable resource", () => {
    const one = webSelfhostResources("A fixed launch/id with an intentionally very long suffix for PostgreSQL")
    const two = webSelfhostResources("another launch")
    expect(one.runId).toHaveLength(40)
    expect(new Set([
      one.image, one.network, one.postgresContainer, one.appContainer,
      one.postgresVolume, one.dataVolume, one.database, one.hostPort
    ]).size).toBe(8)
    expect(one.hostPort).toBeGreaterThanOrEqual(20_000)
    expect(one.hostPort).toBeLessThan(60_000)
    expect(Buffer.byteLength(one.database)).toBeLessThanOrEqual(63)
    expect(Object.values(one).every((value) => !String(value).includes("another-launch"))).toBe(true)
    expect(two.network).not.toBe(one.network)
  })

  test("a build failure removes only resources the launcher actually created and records the command failure", async () => {
    const calls: string[][] = []
    const executor: CommandExecutor = async (args) => {
      calls.push([...args])
      if (args.includes("inspect")) return absentInspect(args)
      if (args[1] === "build") return { exitCode: 17, stdout: "", stderr: "packaged compile failed" }
      return { exitCode: 0, stdout: "created\n", stderr: "" }
    }
    const outputDir = temporary()
    await expect(startPackagedWebSelfhost({ rootDir: outputDir, revision, outputDir, executor })).rejects.toThrow("build packaged product image failed")

    const report = JSON.parse(readFileSync(join(outputDir, "web-selfhost.launch.json"), "utf8")) as {
      readonly status: string
      readonly failure: string
      readonly commands: ReadonlyArray<{ readonly label: string; readonly status: string }>
    }
    expect(report.status).toBe("failed")
    expect(report.failure).toContain("packaged compile failed")
    expect(report.commands).toContainEqual(expect.objectContaining({ label: "build packaged product image", status: "failed" }))
    expect(calls.some((args) => args[1] === "volume" && args[2] === "rm")).toBe(true)
    expect(calls.some((args) => args[1] === "network" && args[2] === "rm")).toBe(true)
    expect(calls.some((args) => args[1] === "container" && args[2] === "rm")).toBe(false)
    expect(calls.some((args) => args[1] === "image" && args[2] === "rm")).toBe(false)
  })

  test("fails closed when Docker inspection cannot establish that resources are absent", async () => {
    const calls: string[][] = []
    const executor: CommandExecutor = async (args) => {
      calls.push([...args])
      return {
        exitCode: 1,
        stdout: "",
        stderr: "permission denied while trying to connect to the Docker daemon socket"
      }
    }
    const outputDir = temporary()
    await expect(startPackagedWebSelfhost({ rootDir: outputDir, revision, outputDir, executor })).rejects.toThrow(
      "prove app container is fresh failed"
    )

    const report = JSON.parse(readFileSync(join(outputDir, "web-selfhost.launch.json"), "utf8")) as {
      readonly status: string
      readonly failure: string
      readonly commands: ReadonlyArray<{ readonly label: string; readonly status: string; readonly detail?: string }>
    }
    expect(report.status).toBe("failed")
    expect(report.failure).toContain("permission denied")
    expect(report.commands).toContainEqual(expect.objectContaining({
      label: "prove app container is fresh",
      status: "failed",
      detail: expect.stringContaining("permission denied")
    }))
    expect(calls.some((args) => args.includes("create") || args.includes("build") || args.includes("run"))).toBe(false)
  })

  test("writes restart evidence only after both database and data-volume markers survive", async () => {
    const calls: string[][] = []
    let marker = ""
    const executor: CommandExecutor = async (args) => {
      calls.push([...args])
      if (args.includes("inspect")) return absentInspect(args)
      if (args[1] === "port") {
        const publishCall = calls.find((call) => call.includes("--publish"))
        const publishIndex = publishCall?.indexOf("--publish") ?? -1
        const published = publishIndex < 0 ? undefined : publishCall?.[publishIndex + 1]
        const hostPort = /^127\.0\.0\.1:([0-9]+):4000$/.exec(published ?? "")?.[1]
        return { exitCode: hostPort === undefined ? 1 : 0, stdout: hostPort === undefined ? "" : `127.0.0.1:${hostPort}\n`, stderr: "" }
      }
      if (args.includes("psql")) {
        const sql = args.at(-1) ?? ""
        marker ||= /marker='([^']+)'/.exec(sql)?.[1] ?? /VALUES \('([^']+)'\)/.exec(sql)?.[1] ?? ""
        return { exitCode: 0, stdout: `${marker}\n`, stderr: "" }
      }
      return { exitCode: 0, stdout: "ok\n", stderr: "" }
    }
    const fetcher = async (input: string | URL | Request): Promise<Response> => {
      const path = new URL(String(input)).pathname
      return path === "/api/bootstrap"
        ? new Response(JSON.stringify({ host: "local", capabilities: ["identity"] }), { status: 200, headers: { "content-type": "application/json" } })
        : new Response("ok", { status: 200 })
    }
    const outputDir = temporary()
    const session = await startPackagedWebSelfhost({
      rootDir: outputDir,
      revision,
      outputDir,
      executor,
      fetcher,
      wait: async () => undefined,
      now: () => new Date("2026-09-21T12:00:00.000Z")
    })

    const publishCall = calls.find((args) => args.includes("--publish"))
    const publishIndex = publishCall?.indexOf("--publish") ?? -1
    const published = publishIndex < 0 ? undefined : publishCall?.[publishIndex + 1]
    const hostPort = /^127\.0\.0\.1:([0-9]+):4000$/.exec(published ?? "")?.[1]
    expect(hostPort).toBeDefined()
    expect(session.modeConfig.origin).toBe(`http://127.0.0.1:${hostPort}`)
    const ownerCredentials = JSON.parse(session.runtimeEnvironment.SMITHERS_SELFHOST_OWNER_SESSION ?? "") as {
      readonly username?: unknown
      readonly password?: unknown
      readonly bootstrapToken?: unknown
    }
    expect(ownerCredentials.username).toBe("matrix-owner")
    expect(typeof ownerCredentials.password).toBe("string")
    expect(typeof ownerCredentials.bootstrapToken).toBe("string")
    const appLaunch = calls.find((args) => args[1] === "run" && args.includes("SMITHERS_AUTH_MODE=selfhost"))
    expect(appLaunch).toContain(`SMITHERS_PUBLIC_URL=${session.modeConfig.origin}`)
    expect(appLaunch).toContain(`SMITHERS_AUTH_BOOTSTRAP_TOKEN=${String(ownerCredentials.bootstrapToken)}`)
    expect(session.receipt).toMatchObject({
      mode: "web-selfhost",
      ready: true,
      startedRoles: ["docker-app", "postgres"],
      freshLaunch: true,
      restarted: true,
      dataPreserved: true,
      persistenceProof: {
        database: { before: marker, after: marker },
        dataVolume: { before: marker, after: marker }
      }
    })
    expect(marker).not.toBe("")
    expect(calls.filter((args) => args[1] === "restart")).toHaveLength(1)
    await session.close()
    const reportText = readFileSync(session.reportPath, "utf8")
    expect(reportText).not.toContain(String(ownerCredentials.password))
    expect(reportText).not.toContain(String(ownerCredentials.bootstrapToken))
    const report = JSON.parse(reportText) as { readonly status: string }
    expect(report.status).toBe("stopped")
  })
})
