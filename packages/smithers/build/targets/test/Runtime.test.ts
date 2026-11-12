import { describe, expect, it } from "vitest"
import * as Runtime from "../src/Runtime.ts"

describe("Runtime declarations", () => {
  it("hardcodes the name of each variant", () => {
    expect(Runtime.Node({ version: ">=26.4.0" })).toEqual({
      name: "node",
      version: ">=26.4.0",
      executable: "node"
    })
    expect(Runtime.Bun({ version: ">=1.4.0" })).toEqual({
      name: "bun",
      version: ">=1.4.0",
      executable: "bun"
    })
  })

  it("discriminates the union on `name`", () => {
    const declarations: ReadonlyArray<Runtime.NodeRuntime | Runtime.BunRuntime> = [
      Runtime.Node({ version: ">=26.4.0" }),
      Runtime.Bun({ version: ">=1.4.0" })
    ]
    const versions = declarations.map((runtime) => {
      // The narrowing is the assertion: each branch sees only its own
      // variant's version enumeration, so a Bun requirement in the Node branch
      // would not typecheck.
      switch (runtime.name) {
        case "node": {
          const version: Runtime.NodeVersion = runtime.version
          return version
        }
        case "bun": {
          const version: Runtime.BunVersion = runtime.version
          return version
        }
      }
    })
    expect(versions).toEqual([">=26.4.0", ">=1.4.0"])
  })

  it("routes versions outside the PACKAGE.ts enumeration to the WORKSPACE.ts declaration", () => {
    // The reviewed enumeration still selects the classic NodeRuntime; any
    // other version string is the WORKSPACE.ts form and returns the inert
    // NodeDeclaration that the planner resolves before execution. Bun accepts
    // exact pins directly, but not another interpreter's comparator floor.
    const pinned = Runtime.Node({ version: "24.9.0" })
    expect(Runtime.isNodeDeclaration(pinned)).toBe(true)
    expect(Runtime.isRuntime(pinned)).toBe(false)
    expect(() => Runtime.Bun({ version: ">=26.4.0" })).toThrow()
  })

  it("rejects missing Node options and admits an exact Bun workspace pin", () => {
    expect(() => Runtime.Node(null as never)).toThrow(TypeError)
    expect(() => Runtime.Node(null as never)).toThrow("Runtime.Node options must be an object")
    expect(() => Runtime.Node({} as never)).toThrow("Runtime.Node requires a manifest or a version")

    const bun = Runtime.Bun({ version: "1.4.1" })
    expect(Runtime.isRuntime(bun)).toBe(true)
    expect(bun).toEqual({ _tag: "ResolvedBunRuntime", name: "bun", version: "1.4.1", executable: "bun" })
  })

  it("honours an executable override and rejects unusable ones", () => {
    expect(Runtime.Node({ version: ">=26.4.0", executable: "/opt/node/bin/node" }).executable).toBe(
      "/opt/node/bin/node"
    )
    expect(() => Runtime.Node({ version: ">=26.4.0", executable: "  " })).toThrow(/must not be empty/)
    expect(() => Runtime.Node({ version: ">=26.4.0", executable: "node\u0000" }))
      .toThrow(/without control characters/)
    expect(() => Runtime.Node({ version: ">=26.4.0", executable: "a".repeat(257) })).toThrow(
      /bounded well-formed text/
    )
  })

  it("recognises only the declared variants", () => {
    expect(Runtime.isRuntime(Runtime.Node({ version: ">=26.4.0" }))).toBe(true)
    expect(Runtime.isRuntime(Runtime.Bun({ version: ">=1.4.0" }))).toBe(true)
    expect(Runtime.isRuntime({ name: "deno", version: "2.1.4", executable: "deno" })).toBe(false)
    expect(Runtime.isRuntime({ name: "node", version: "24.9.0", executable: "node" })).toBe(false)
    expect(Runtime.isRuntime({ name: "bun", version: ">=26.4.0", executable: "bun" })).toBe(false)
    expect(Runtime.isRuntime({ name: "node", version: ">=26.4.0", executable: "" })).toBe(false)
    expect(Runtime.isRuntime({ name: "node" })).toBe(false)
    expect(Runtime.isRuntime(null)).toBe(false)
    expect(Runtime.isRuntime("node")).toBe(false)
  })

  it("admits tagged resolved requirements without widening classic declarations", () => {
    const node = Runtime.ResolvedNodeRuntime.make({ name: "node", version: "22.19.0", executable: "node-22" })
    expect(Runtime.isRuntime(node)).toBe(true)
    expect(Runtime.run(node, ["build.mjs"])).toEqual(["node-22", "build.mjs"])
    for (const version of ["", "  ", "22.19.0\n", "22\u0000", "x".repeat(257)]) {
      expect(() => Runtime.ResolvedNodeRuntime.make({ name: "node", version, executable: "node" })).toThrow()
    }
  })

  it("builds argv for a script and for an inline program", () => {
    const runtime = Runtime.Node({ version: ">=26.4.0" })
    expect(Runtime.run(runtime, ["build.mjs", "--check"])).toEqual(["node", "build.mjs", "--check"])
    expect(Runtime.evaluate(runtime, "console.log(1)", ["x"])).toEqual([
      "node",
      "-e",
      "console.log(1)",
      "x"
    ])
    expect(Runtime.evaluate(Runtime.Bun({ version: ">=1.4.0" }), "console.log(1)")).toEqual([
      "bun",
      "-e",
      "console.log(1)"
    ])
  })

  it("preloads a Node runtime's imports before every program it runs", () => {
    // A workspace whose sources need a loader, such as VibeLang's
    // vibelang/register for .vibe modules, declares it once here.
    const runtime = Runtime.Node({ version: ">=26.4.0", imports: ["vibelang/register", "./hooks.mjs"] })
    expect(runtime.imports).toEqual(["vibelang/register", "./hooks.mjs"])
    const preloads = ["--import=vibelang/register", "--import=./hooks.mjs"]
    expect(Runtime.run(runtime, ["build.mjs"])).toEqual(["node", ...preloads, "build.mjs"])
    expect(Runtime.test(runtime, ["a.test.ts"])).toEqual(["node", ...preloads, "--test", "a.test.ts"])
    expect(Runtime.evaluate(runtime, "1", ["x"])).toEqual(["node", ...preloads, "-e", "1", "x"])
    const resolved = Runtime.ResolvedNodeRuntime.make({
      name: "node",
      version: "26.4.1",
      executable: "node",
      imports: ["vibelang/register"]
    })
    expect(Runtime.run(resolved, ["a.mjs"])).toEqual(["node", "--import=vibelang/register", "a.mjs"])
  })

  it("hands a Node runtime's imports to descendant processes through NODE_OPTIONS", () => {
    // Argv preloads reach only the program the argv starts; a child that
    // program spawns inherits the environment instead.
    const runtime = Runtime.Node({ version: ">=26.4.0", imports: ["vibelang/register", "./hooks.mjs"] })
    const tokens = `${Runtime.importTokenPrefix}vibelang/register} ${Runtime.importTokenPrefix}./hooks.mjs}`
    expect(Runtime.environment(runtime)).toEqual({ NODE_OPTIONS: tokens })
    expect(Runtime.environment(runtime, { CI: "1", NODE_OPTIONS: "--no-warnings" })).toEqual({
      CI: "1",
      NODE_OPTIONS: `${tokens} --no-warnings`
    })
    // The exec boundary refuses two names that differ only in case, and Node
    // reads only NODE_OPTIONS, so a declared value in another case moves there.
    expect(Runtime.environment(runtime, { node_options: "--no-warnings" })).toEqual({
      NODE_OPTIONS: `${tokens} --no-warnings`
    })
    for (const plain of [Runtime.Node({ version: ">=26.4.0" }), Runtime.Bun({ version: ">=1.4.0" }), undefined]) {
      expect(Runtime.environment(plain, { NODE_OPTIONS: "--no-warnings" })).toEqual({ NODE_OPTIONS: "--no-warnings" })
      expect(Runtime.environment(plain)).toEqual({})
    }
  })

  it("keeps a runtime without imports exactly as before", () => {
    expect(Runtime.Node({ version: ">=26.4.0", imports: [] })).toEqual(Runtime.Node({ version: ">=26.4.0" }))
    expect(Runtime.Node({ version: ">=26.4.0" })).not.toHaveProperty("imports")
  })

  it("carries imports on the WORKSPACE.ts declaration forms", () => {
    const declared = Runtime.Node({ version: "26.4.1", imports: ["vibelang/register"] })
    expect(Runtime.isNodeDeclaration(declared)).toBe(true)
    expect(declared.imports).toEqual(["vibelang/register"])
  })

  it("refuses an import that is not one bounded module specifier", () => {
    for (const specifier of ["", " vibelang/register", "-e", "a b", "x\u0000", "y\n", "z".repeat(257)]) {
      expect(() => Runtime.Node({ version: ">=26.4.0", imports: [specifier] })).toThrow(/runtime import/)
    }
    expect(() => Runtime.Node({ version: ">=26.4.0", imports: "vibelang/register" as never })).toThrow(
      /runtime imports/
    )
  })
})
