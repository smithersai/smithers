// Which Hyperdrive config each part of ChatApi's Worker reaches Postgres through (worker/DatabaseRoutes.ts, decision
// 0150). The routes are data; the program must take every consumer's config from them, which this file checks against
// the program's source, since only a deployed Worker shows which binding a Durable Object opened.
import { describe, expect, test } from "vitest"
import { sourceText, sourcesUnder } from "../../../packages/repo-targets/test-utils/source-readers.mjs"
import { route, ROUTES } from "./DatabaseRoutes.ts"

/** A Worker module's source as written, .ts or .vibe. */
const source = (path: string) => sourceText(new URL(path, import.meta.url))
const opens = (path: string) => source(path).includes("Hyperdrive.Connect(")

/** Every module of the Worker (worker/, not its tests) that opens a Hyperdrive config itself. */
const connecting = () =>
  sourcesUnder(new URL(".", import.meta.url), (path) => path === "test" || path.includes(".test.")).filter(opens)

describe("database routes", () => {
  test("the request path reads through ChatDatabase; the engine and the sandbox objects it calls, EngineDatabase", () => {
    expect(ROUTES).toEqual({
      requests: "request",
      FlowExecution: "engine",
      SandboxObject: "engine",
      GateObject: "engine",
      RoomObject: "request",
      RunContent: "request",
      SocketChecks: "request",
    })
    expect(route({ request: "ChatDatabase", engine: "EngineDatabase" }, "SandboxObject")).toBe("EngineDatabase")
    expect(route({ request: "ChatDatabase", engine: "EngineDatabase" }, "requests")).toBe("ChatDatabase")
  })

  test("the program takes each consumer's config from its route, and no other module opens one of its own", () => {
    const program = source("ChatApiProgram.ts")
    expect(program).toContain(`Hyperdrive.Connect(DatabaseRoutes.route(pools, "requests"))`)
    expect(program).toContain(`Executions.live(DatabaseRoutes.route(pools, "FlowExecution")`)
    expect(program).toContain(`BranchSandboxes.live(\n      DatabaseRoutes.route(pools, "SandboxObject"),`)
    expect(program).toContain(`BranchSandboxes.gateLive(\n      DatabaseRoutes.route(pools, "GateObject"),`)
    // Socket hosts renew leases on the request path, the terminal's through its own route.
    expect(program.match(/DatabaseRoutes\.route\(pools, "SocketChecks"\)/g)).toHaveLength(2)
    expect(program).toContain(`BranchRooms.live(DatabaseRoutes.route(pools, "RoomObject")`)
    expect(program).toContain(`RunContent.live(DatabaseRoutes.route(pools, "RunContent")`)
    // Neither config is handed to a consumer any other way.
    expect(program.match(/\(\s*(ChatDatabase|EngineDatabase)\s*[,)]/g)).toBeNull()
    // The modules that open the config they are given: a new one needs a route here first.
    // Each sandbox constructor hands its sockets' checks the SocketChecks route, and the object builds them from it, not
    // from the engine pool it was given for its own work.
    expect(program).toContain([
      `BranchSandboxes.live(`,
      `      DatabaseRoutes.route(pools, "SandboxObject"),`,
      `      socketChecks(options),`,
      `      DatabaseRoutes.route(pools, "SocketChecks"),`,
    ].join("\n"))
    expect(program).toContain([
      `BranchSandboxes.gateLive(`,
      `      DatabaseRoutes.route(pools, "GateObject"),`,
      `      socketChecks(options),`,
      `      DatabaseRoutes.route(pools, "SocketChecks"),`,
    ].join("\n"))
    const sandboxes = source("BranchSandboxes.ts")
    expect(sandboxes.match(/implementation\(connection, checks, checkConnection, \{/g)).toHaveLength(2)
    expect(sandboxes.match(/SocketChecks\.checker\(([A-Za-z]+),/g)).toEqual(["SocketChecks.checker(checkConnection,"])
    expect(connecting()).toEqual(["BranchSandboxes.ts", "ChatApiProgram.ts", "Executions.ts", "SocketChecks.ts"])
  })

  test("finds a module converted to VibeLang that opens a config, as it finds its TypeScript twin", () => {
    expect([opens("../tests/fixtures/source-readers/vibe/Twin.ts"), opens("../tests/fixtures/source-readers/ts/Twin.ts")]).toEqual([true, true])
  })
})
