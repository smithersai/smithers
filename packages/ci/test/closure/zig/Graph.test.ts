import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as Graph from "../../../src/closure/zig/Graph.ts"
import * as Zon from "../../../src/closure/zig/Zon.ts"

/** What a real `zig build --print-configuration` printed for the fixture project. */
const recorded = readFileSync(new URL("../../fixtures/closure-zig/configuration.zon", import.meta.url), "utf8")

const graph = (text: string): Graph.Graph | undefined => {
  const parsed = Zon.parse(text)
  return parsed.ok ? Graph.read(parsed.value) : undefined
}

const real = graph(recorded) as Graph.Graph

const names = (steps: ReadonlyArray<Graph.Step>): ReadonlyArray<string> => steps.map((step) => step.name)

/** A configuration with one step whose `extended` data is `extended`. */
const one = (extended: string): Graph.Step | undefined =>
  graph(`.{ .top_level_steps = .{}, .steps = .{ .{ .name = "s", .deps = .{}, .extended = ${extended} } } }`)?.steps[0]

describe("Graph.read on a real configuration", () => {
  it("reads every step and the names zig build accepts", () => {
    expect(real.steps.length).toBe(21)
    expect([...real.named]).toEqual([
      ["install", 0],
      ["uninstall", 1],
      ["test-alpha", 2],
      ["test-beta", 3],
      ["test-gamma", 4],
      ["test", 5],
      ["test-broken", 6],
      ["fmt", 7],
      ["run", 8]
    ])
    expect(real.steps[17]).toEqual({
      index: 17,
      name: "compile test gamma debug native",
      kind: "compile",
      deps: [20],
      paths: [],
      open: [],
      test: false
    })
  })

  it("marks the steps that run a test binary", () => {
    expect(names(real.steps.filter((step) => step.test))).toEqual([
      "run test alpha",
      "run test beta",
      "run test gamma",
      "run test broken"
    ])
  })

  it("reads the paths a step declares", () => {
    expect(real.steps[20]).toMatchObject({
      name: "run cp (words.zig)",
      kind: "run",
      paths: ["data/words.zig.in"],
      open: []
    })
    expect(real.steps[13]).toMatchObject({ name: "zig fmt --check", kind: "fmt", paths: ["src"], open: [] })
  })

  it("reports a command Zig reruns every time", () => {
    expect(real.steps[14]).toMatchObject({ name: "run exe hello", open: ["a command Zig reruns every time"] })
  })
})

describe("Graph.read", () => {
  it("refuses a value that is not a configuration", () => {
    expect(graph(".{}")).toBeUndefined()
    expect(graph(".{ .steps = .{} }")).toBeUndefined()
    expect(graph(".{ .steps = .{ .{ .name = \"no kind\" } } }")).toBeUndefined()
    expect(graph(".{ .steps = .{ .{ .extended = .{ .flags = .{ .tag = .run } } } } }")).toBeUndefined()
  })

  it("keeps only numeric dependencies and numeric step names", () => {
    const read = graph(`.{
      .top_level_steps = .{ .a = 0, .b = "x" },
      .steps = .{ .{ .name = "a", .deps = .{ 1, .odd }, .extended = .{ .flags = .{ .tag = .top_level } } } },
    }`)
    expect(read?.steps[0]?.deps).toEqual([1])
    expect([...(read?.named ?? [])]).toEqual([["a", 0]])
  })

  it("reports a step of a kind it does not know", () => {
    expect(one(".{ .flags = .{ .tag = .teleport } }")?.open).toEqual([
      "a step of a kind this strategy does not know: teleport"
    ])
  })

  it("reports a path it cannot place", () => {
    const flags = ".flags = .{ .tag = .install_file }"
    expect(one(`.{ ${flags}, .source = .{ .flags = .{ .tag = .source_path }, .owner = 12, .sub_path = "a.txt" } }`))
      .toMatchObject({ paths: [], open: ["a path in another package: a.txt"] })
    expect(one(`.{ ${flags}, .source = .{ .flags = .{ .tag = .relative }, .sub_path = "/etc/hosts" } }`))
      .toMatchObject({ paths: [], open: ["a path outside the build: /etc/hosts"] })
    // A generated path is another step's output; that step is a dependency.
    expect(one(`.{ ${flags}, .source = .{ .flags = .{ .tag = .generated }, .index = 3, .sub_path = "" } }`))
      .toMatchObject({ paths: [], open: [] })
    expect(one(`.{ ${flags}, .list = .{ .{ .flags = .{ .tag = .source_path }, .owner = .root, .sub_path = "b" } } }`))
      .toMatchObject({ paths: ["b"], open: [] })
  })

  it("applies Zig's rule for a command with side effects", () => {
    const run = (flags: string, rest = ""): ReadonlyArray<string> | undefined =>
      one(
        `.{ .flags = .{ .tag = .run, ${flags} }, .captured_stdout = null, .captured_stderr = null, .args = .{} ${rest} }`
      )?.open
    const rerun = ["a command Zig reruns every time"]
    expect(run(".has_side_effects = true, .stdio = .check")).toEqual(rerun)
    expect(run(".has_side_effects = false, .stdio = .inherit")).toEqual(rerun)
    expect(run(".has_side_effects = false, .stdio = .infer_from_args")).toEqual(rerun)
    expect(run(".has_side_effects = false, .stdio = .check")).toEqual([])
    expect(run(".has_side_effects = false, .stdio = .zig_test")).toEqual([])
    const infer = ".{ .flags = .{ .tag = .run, .has_side_effects = false, .stdio = .infer_from_args }"
    expect(one(`${infer}, .captured_stdout = 4, .captured_stderr = null, .args = .{} }`)?.open).toEqual([])
    expect(one(`${infer}, .captured_stdout = null, .captured_stderr = 4, .args = .{} }`)?.open).toEqual([])
    expect(
      one(
        `${infer}, .captured_stdout = null, .captured_stderr = null, .args = .{ .{ .flags = .{ .tag = .output_file } } } }`
      )?.open
    ).toEqual([])
    expect(
      one(
        `${infer}, .captured_stdout = null, .captured_stderr = null, .args = .{ .{ .flags = .{ .tag = .string } }, 7 } }`
      )?.open
    ).toEqual(rerun)
  })
})

describe("Graph.reach", () => {
  it("returns the step and everything it depends on, in index order", () => {
    expect(names(Graph.reach(real, 4))).toEqual([
      "test-gamma",
      "run test gamma",
      "compile test gamma debug native",
      "run cp (words.zig)"
    ])
    expect(Graph.reach(real, 5).map((step) => step.index)).toEqual([2, 3, 4, 5, 9, 10, 11, 15, 16, 17, 20])
  })

  it("skips a dependency the configuration does not hold, and ends on a cycle", () => {
    const loop = graph(`.{ .steps = .{
      .{ .name = "a", .deps = .{ 1, 9 }, .extended = .{ .flags = .{ .tag = .top_level } } },
      .{ .name = "b", .deps = .{ 0 }, .extended = .{ .flags = .{ .tag = .top_level } } },
    } }`) as Graph.Graph
    expect(names(Graph.reach(loop, 0))).toEqual(["a", "b"])
    expect(Graph.reach(loop, 7)).toEqual([])
  })
})

describe("Graph.find", () => {
  it("finds a step by the name zig build accepts, then by its own name", () => {
    expect(Graph.find(real, "test")?.index).toBe(5)
    expect(Graph.find(real, "run test beta")?.index).toBe(10)
    expect(Graph.find(real, "no such step")).toBeUndefined()
  })

  it("refuses an own name that more than one step has", () => {
    const twins = graph(`.{ .steps = .{
      .{ .name = "twin", .deps = .{}, .extended = .{ .flags = .{ .tag = .options } } },
      .{ .name = "twin", .deps = .{}, .extended = .{ .flags = .{ .tag = .options } } },
    } }`) as Graph.Graph
    expect(Graph.find(twins, "twin")).toBeUndefined()
  })
})
