import { describe, expect, it } from "vitest"
import { cacheActions, checkoutProblems, parseYaml, readAction, setupVariables } from "../../src/inventory/Actions.vibe"
import type { Residual } from "../../src/inventory/Expression.ts"

const sha: Residual = { kind: "variable", variable: { id: "sha", name: "github.sha", nullable: false, typed: false } }
const before: Residual = {
  kind: "variable",
  variable: { id: "before", name: "github.event.before", nullable: false, typed: false }
}
const literal = (value: string | null): Residual => ({ kind: "literal", value })
const binary = (operator: "||" | "&&" | "==", left: Residual, right: Residual): Residual => ({
  kind: "binary",
  operator,
  left,
  right
})

describe("setupVariables", () => {
  // "actions/setup-python" sets `pythonLocation`; "actions/setup-java" sets `JAVA_HOME`.
  it("names the variables a setup action sets for later steps, by the tool it installs", () => {
    expect(setupVariables.get("python")).toContain("pythonLocation")
    expect(setupVariables.get("java")).toEqual(["JAVA_HOME"])
    expect(setupVariables.get("rust")).toContain("RUSTFLAGS")
    expect(setupVariables.has("zig")).toBe(false)
  })
})

describe("cacheActions", () => {
  it("lists the cache actions", () => {
    expect(cacheActions).toEqual(["actions/cache", "actions/cache/restore", "actions/cache/save"])
  })
})

describe("checkoutProblems", () => {
  // actions/checkout inputs: repository, ref, path, submodules, lfs.
  const text = (held: string) => held
  const repository = "elizaOS/eliza"

  it("finds nothing when the inputs are not a mapping", () => {
    expect(checkoutProblems(undefined, repository, text)).toEqual([])
    expect(checkoutProblems(["ref"], repository, text)).toEqual([])
    expect(checkoutProblems("ref", repository, text)).toEqual([])
  })

  it("finds nothing when no input is given", () => {
    expect(checkoutProblems({}, repository, text)).toEqual([])
    expect(checkoutProblems({}, undefined, text)).toEqual([])
  })

  // actions/checkout inputs: repository defaults to ${{ github.repository }}.
  it("accepts the replayed repository", () => {
    expect(checkoutProblems({ repository }, repository, text)).toEqual([])
  })

  it("refuses another repository, or any when the replayed one is unknown", () => {
    expect(checkoutProblems({ repository: "elizaOS/plugins" }, repository, text)).toEqual([
      "checks out another repository"
    ])
    expect(checkoutProblems({ repository }, undefined, text)).toEqual(["checks out another repository"])
    expect(checkoutProblems({ repository: ["elizaOS/eliza"] }, repository, text)).toEqual([
      "checks out another repository"
    ])
  })

  // actions/checkout inputs: path is relative to $GITHUB_WORKSPACE.
  it("refuses another directory", () => {
    expect(checkoutProblems({ path: "eliza" }, repository, text)).toEqual([
      "checks the repository out into another directory"
    ])
  })

  // actions/checkout inputs: ref empty checks out the event's commit.
  it("accepts an empty ref", () => {
    expect(checkoutProblems({ ref: "" }, repository, text)).toEqual([])
    expect(checkoutProblems({ ref: null }, repository, text)).toEqual([])
  })

  it("refuses a ref given as text", () => {
    expect(checkoutProblems({ ref: "main" }, repository, text)).toEqual([
      "checks out a commit that may not be the one under replay"
    ])
  })

  it("accepts a ref that is the commit under replay", () => {
    const as = (residual: Residual) => () => residual
    expect(checkoutProblems({ ref: "${{ github.sha }}" }, repository, as(sha))).toEqual([])
    expect(checkoutProblems({ ref: "x" }, repository, as(binary("||", sha, sha)))).toEqual([])
    expect(checkoutProblems({ ref: "x" }, repository, as(binary("||", literal(""), sha)))).toEqual([])
    expect(checkoutProblems({ ref: "x" }, repository, as(binary("&&", literal(null), sha)))).toEqual([])
  })

  it("refuses a ref that may be another commit", () => {
    const as = (residual: Residual) => () => residual
    const refused = ["checks out a commit that may not be the one under replay"]
    expect(checkoutProblems({ ref: "x" }, repository, as(before))).toEqual(refused)
    expect(checkoutProblems({ ref: "x" }, repository, as(literal("main")))).toEqual(refused)
    expect(checkoutProblems({ ref: "x" }, repository, as(binary("||", sha, before)))).toEqual(refused)
    expect(checkoutProblems({ ref: "x" }, repository, as(binary("||", before, sha)))).toEqual(refused)
    expect(checkoutProblems({ ref: "x" }, repository, as(binary("==", sha, sha)))).toEqual(refused)
    expect(checkoutProblems({ ref: "x" }, repository, as({ kind: "not", operand: sha }))).toEqual(refused)
  })

  it("refuses a ref that cannot be read", () => {
    const refused = ["checks out a commit that may not be the one under replay"]
    expect(checkoutProblems({ ref: ["main"] }, repository, text)).toEqual(refused)
    expect(checkoutProblems({ ref: "${{ matrix.ref }}" }, repository, () => undefined)).toEqual(refused)
  })

  // actions/checkout inputs: submodules is false by default; true or recursive fetch them.
  it("accepts submodules: false and refuses submodules", () => {
    expect(checkoutProblems({ submodules: false }, repository, text)).toEqual([])
    expect(checkoutProblems({ submodules: true }, repository, text)).toEqual(["checks out submodules"])
    expect(checkoutProblems({ submodules: "recursive" }, repository, text)).toEqual(["checks out submodules"])
  })

  // actions/checkout inputs: lfs is false by default.
  it("refuses large files", () => {
    expect(checkoutProblems({ lfs: false }, repository, text)).toEqual([])
    expect(checkoutProblems({ lfs: true }, repository, text)).toEqual(["checks out large files"])
  })

  it("lists every problem in order", () => {
    expect(
      checkoutProblems(
        { repository: "elizaOS/plugins", path: "p", ref: "v1", submodules: "recursive", lfs: "true" },
        repository,
        text
      )
    ).toEqual([
      "checks out another repository",
      "checks the repository out into another directory",
      "checks out a commit that may not be the one under replay",
      "checks out submodules",
      "checks out large files"
    ])
  })
})

describe("parseYaml", () => {
  it("gives the value of YAML that parses", () => {
    expect(parseYaml("a: 1\nb: [x, y]\n")).toEqual({ value: { a: 1, b: ["x", "y"] } })
  })

  it("names the error and its line when YAML does not parse", () => {
    expect(parseYaml("a: 1\nb: [x, y\n")).toEqual({ problem: expect.stringMatching(/^[A-Z_]+ at line \d+$/) })
  })
})

describe("readAction", () => {
  // Metadata syntax for GitHub Actions: runs for composite actions.
  it("reads a composite action's inputs, outputs and steps", () => {
    const action = readAction([
      "name: Setup",
      "inputs:",
      "  Node-Version:",
      "    description: the node version",
      "    default: '20'",
      "  token:",
      "    description: no default",
      "  bare:",
      "outputs:",
      "  cache-hit:",
      "    value: ${{ steps.cache.outputs.cache-hit }}",
      "  Described:",
      "    description: no value",
      "  bare:",
      "runs:",
      "  using: composite",
      "  steps:",
      "    - run: echo hi",
      "      shell: bash"
    ].join("\n"))
    expect(action).toEqual({
      inputs: new Map([["node-version", "20"], ["token", undefined], ["bare", undefined]]),
      outputs: new Map([["cache-hit", "${{ steps.cache.outputs.cache-hit }}"]]),
      steps: [{ run: "echo hi", shell: "bash" }]
    })
  })

  it("reads a composite action with no inputs or outputs", () => {
    expect(readAction("runs:\n  using: composite\n  steps: []\n")).toEqual({
      inputs: new Map(),
      outputs: new Map(),
      steps: []
    })
  })

  it("says when the action file does not parse", () => {
    const action = readAction("runs: [\n")
    expect(action).toEqual({
      problem: expect.stringMatching(/^its action file does not parse \([A-Z_]+ at line \d+\)$/)
    })
  })

  it("says when its aliases cannot be expanded", () => {
    const lines = ["a: &a [x, x, x, x, x, x, x, x, x, x]"]
    for (let level = 0; level < 8; level++) {
      const previous = String.fromCharCode(97 + level)
      const next = String.fromCharCode(98 + level)
      lines.push(`${next}: &${next} [${Array(10).fill(`*${previous}`).join(", ")}]`)
    }
    const text = lines.join("\n")
    expect(parseYaml(text)).toEqual({ problem: "its aliases cannot be expanded" })
    expect(readAction(text)).toEqual({ problem: "its action file does not parse (its aliases cannot be expanded)" })
  })

  it("says when there is no runs mapping", () => {
    expect(readAction("name: x\n")).toEqual({ problem: "its action file has no runs mapping" })
    expect(readAction("runs: composite\n")).toEqual({ problem: "its action file has no runs mapping" })
    expect(readAction("- runs\n")).toEqual({ problem: "its action file has no runs mapping" })
  })

  // Metadata syntax for GitHub Actions: runs for JavaScript actions.
  it("does not read a JavaScript action", () => {
    expect(readAction("runs:\n  using: node20\n  main: index.js\n")).toEqual({
      problem: "it runs with node20, and only a composite action has steps to read"
    })
  })

  it("does not read a composite action with no steps list", () => {
    expect(readAction("runs:\n  using: composite\n")).toEqual({
      problem: "it runs with composite, and only a composite action has steps to read"
    })
    expect(readAction("runs:\n  using: composite\n  steps: echo\n")).toEqual({
      problem: "it runs with composite, and only a composite action has steps to read"
    })
  })
})

describe("what the review found", () => {
  it("reports YAML whose alias names itself, and never reads without end", () => {
    expect(parseYaml("matrix:\n  include: [ &x { a: *x } ]")).toEqual({ problem: "its aliases cannot be expanded" })
  })

  it("says what an action runs with when that is not text", () => {
    expect(readAction("runs: { using: { toString: 1 }, steps: [] }")).toEqual({
      problem: "it runs with a value that is not text, and only a composite action has steps to read"
    })
  })

  // "actions/checkout: sparse-checkout, filter": the workspace then holds part of the repository.
  it("reports a checkout of part of the repository", () => {
    const text = (held: string) => held
    expect(checkoutProblems({ "sparse-checkout": "src" }, "acme/widgets", text)).toEqual([
      "checks out part of the repository"
    ])
    expect(checkoutProblems({ filter: "blob:none" }, "acme/widgets", text)).toEqual([
      "checks out part of the repository"
    ])
    expect(checkoutProblems({ "fetch-depth": 0 }, "acme/widgets", text)).toEqual([])
  })
})
