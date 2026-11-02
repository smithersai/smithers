// Which Hyperdrive config each part of ChatApi's Worker reaches Postgres through (worker/DatabaseRoutes.ts, decision
// 0150). The routes are data; the program must take every consumer's config from them, which this file checks against
// the program's source, since only a deployed Worker shows which binding a Durable Object opened.
import { readdirSync, readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { route, ROUTES } from "./DatabaseRoutes.ts"

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

/** Every module of the Worker (worker/, not its tests) that opens a Hyperdrive config itself. */
const connecting = () =>
  readdirSync(new URL(".", import.meta.url), { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".ts") && !path.includes(".test.") && !path.startsWith("test/"))
    .filter((path) => source(path).includes("Hyperdrive.Connect("))
    .sort()

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
    expect(connecting()).toEqual(["BranchSandboxes.ts", "ChatApiProgram.ts", "Executions.ts", "SocketChecks.ts"])
  })
})
