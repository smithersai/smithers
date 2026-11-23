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

  it("marks malformed dependencies and rejects malformed named indices", () => {
    const read = graph(`.{
      .top_level_steps = .{ .a = 0 },
      .steps = .{ .{ .name = "a", .deps = .{ 1, .odd }, .extended = .{ .flags = .{ .tag = .top_level } } } },
    }`)
    expect(read?.steps[0]?.open).toEqual(["the step has unreadable dependencies", "a dependency has no step"])
    for (const index of ["2", "\"x\""]) {
      expect(
        graph(
          `.{ .top_level_steps = .{ .a = ${index} }, .steps = .{ .{ .name = "a", .deps = .{}, .extended = .{ .flags = .{ .tag = .top_level } } } } }`
        )
      ).toBeUndefined()
    }
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

describe("Graph.grouped", () => {
  const top = (index: number, deps: ReadonlyArray<number>): Graph.Step => ({
    index,
    name: `step ${index}`,
    kind: "top_level",
    deps,
    paths: [],
    open: [],
    test: false
  })
  const run = (index: number): Graph.Step => ({ ...top(index, []), kind: "run", test: true })

  it("gives the named steps a real step only groups", () => {
    // `test` depends on `test-alpha`, `test-beta` and `test-gamma` and does nothing else.
    expect(Graph.grouped(real, 5)).toEqual(["test-alpha", "test-beta", "test-gamma"])
  })

  it("gives nothing for a step that depends on a step with no name", () => {
    // `test-alpha` depends on the step that runs its test binary, which `zig build` cannot be asked for.
    expect(Graph.grouped(real, 2)).toEqual([])
    expect(Graph.grouped(real, 0)).toEqual([])
  })

  it("gives nothing for a step that is not there, does work itself, has no name or depends on nothing", () => {
    const graph: Graph.Graph = {
      steps: [top(0, [1, 2]), top(1, []), top(2, []), run(3), { ...run(4), deps: [1, 2] }, top(5, [1, 2])],
      named: new Map([["all", 0], ["a", 1], ["b", 2], ["work", 4]])
    }
    expect(Graph.grouped(graph, 0)).toEqual(["a", "b"])
    expect(Graph.grouped(graph, 99)).toEqual([])
    // A step with a name that runs something is more than a group.
    expect(Graph.grouped(graph, 4)).toEqual([])
    // A grouping step nobody can ask for by name.
    expect(Graph.grouped(graph, 5)).toEqual([])
    expect(Graph.grouped(graph, 1)).toEqual([])
  })

  it("refuses nested groups that would execute the same run step twice", () => {
    const graph: Graph.Graph = {
      steps: [top(0, [1, 2, 3]), top(1, [3, 4]), top(2, [5]), top(3, [5]), top(4, [5]), run(5)],
      named: new Map([["ci", 0], ["test", 1], ["lint", 2], ["unit", 3], ["e2e", 4]])
    }
    // `test` groups `unit` and `e2e`; `lint` runs a step with no name, so it is kept as one.
    expect(Graph.grouped(graph, 0)).toEqual([])
    expect(Graph.grouped(graph, 1)).toEqual([])
  })

  it("opens 30,000 nested groups in dependency order and emits each leaf once", () => {
    const depth = 30_000
    const leaves = Array.from({ length: depth + 1 }, (_, index) => top(depth + index, []))
    const groups = Array.from({ length: depth }, (_, index) => top(index, [index + 1, 2 * depth - index]))
    groups[0] = top(0, [1, 2 * depth, depth])
    const steps = [...groups, ...leaves]
    const graph = { steps, named: new Map(steps.map((step) => [step.name, step.index])) }
    expect(Graph.grouped(graph, 0)).toEqual(leaves.map((leaf) => leaf.name))
  })

  it("keeps a group with an unnamed dependency whole and still emits a shared named dependency", () => {
    const steps = [top(0, [1, 2]), top(1, [2, 3]), top(2, []), run(3)]
    const graph = { steps, named: new Map([["all", 0], ["a", 1], ["b", 2]]) }
    expect(Graph.grouped(graph, 0)).toEqual(["a", "b"])
  })

  it("refuses unknown steps in a proposed group", () => {
    const graph = {
      steps: [top(0, [1, 2]), top(1, []), { ...top(2, []), open: ["unknown"] }],
      named: new Map([["all", 0], ["a", 1], ["b", 2]])
    }
    expect(Graph.grouped(graph, 0)).toEqual([])
  })
  it("gives nothing for a group of one", () => {
    const graph: Graph.Graph = {
      steps: [top(0, [1]), top(1, [2]), run(2)],
      named: new Map([["all", 0], ["only", 1]])
    }
    expect(Graph.grouped(graph, 0)).toEqual([])
  })
})
