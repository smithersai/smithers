import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import type { Ci, Inventory as InventoryDocument, Job, Step } from "../src/contract/Inventory.ts"
import { files } from "../src/generate/index.ts"
import { packagePath, stateDirectory, workflowPath } from "../src/generate/Render.ts"

const step = (id: string, command: string, extra: Partial<Step> = {}): Step => ({
  id,
  command,
  cwd: "",
  env: {},
  secrets: [],
  ...extra
})

const job = (id: string, steps: ReadonlyArray<Step>): Job => ({
  id,
  source: "github-actions",
  file: ".github/workflows/ci.yml",
  name: id,
  needs: [],
  triggers: ["push"],
  matrix: [],
  steps,
  unsupported: []
})

/** One generated file's text, for exactly these jobs taken as the CI. */
const generated = (jobs: ReadonlyArray<Job>, path: string): string => {
  const document: InventoryDocument = {
    version: 1,
    repository: "example/repo",
    commit: "0000000000000000000000000000000000000003",
    toolchains: [],
    jobs
  }
  return Effect.runSync(files(document as Ci)).find((file) => file.path === path)?.content ?? ""
}

/** The directories the workflow saves when a job ends and restores at the next. */
const carried = (workflow: string): ReadonlyArray<string> => {
  const paths = /uses: actions\/cache@v4\n {8}with:\n {10}path: \|\n((?: {12}.*\n)+)/.exec(workflow)?.[1] ?? ""
  return paths.split("\n").filter((line) => line !== "").map((line) => line.trim())
}

/** The steps of a Zig build, as the splitter writes them: the named steps one build ran at the same time. */
const zig = ["test-a", "test-b"].map((name) =>
  step(`a:1:${name}`, `zig build ${name}`, { from: "a:1", atOnce: true, shares: [".zig-cache", "~/.cache/zig"] })
)

describe("what the generated workflow carries from one run to the next", () => {
  const own = [`${stateDirectory}/cache`, `${stateDirectory}/kept`, `${stateDirectory}/node-compile-cache`]

  it("is Smithers build's own: its records, what each step left, and its compiled code", () => {
    expect(carried(generated([job("a", [step("a:1", "npm test")])], workflowPath))).toEqual(own)
  })

  it("holds no cache of a tool a step starts, whatever the step runs", () => {
    for (
      const steps of [
        zig,
        [step("a:1", "zig build test --summary all", { cwd: "tools/gen" })],
        [step("a:1", "go vet ./... && go test -race ./...")],
        [step("a:1", "cargo test --locked"), step("a:2", "pnpm install --frozen-lockfile")],
        // A step that sets where its tool keeps a cache keeps its own value, and the workflow carries no more.
        [step("a:1", "zig build test", { env: { ZIG_LOCAL_CACHE_DIR: "/mnt/cache/zig" } })]
      ]
    ) {
      const workflow = generated([job("a", steps)], workflowPath)
      expect([steps.map((one) => one.command), carried(workflow)]).toEqual([steps.map((one) => one.command), own])
      // No step is told to keep a tool's cache in the directory the workflow carries.
      const source = generated([job("a", steps)], packagePath)
      for (const name of ["GOCACHE", "GOMODCACHE", "GOFLAGS", "CARGO_HOME", "npm_config_cache", "XDG_CACHE_HOME"]) {
        expect([name, source.includes(name)]).toEqual([name, false])
      }
      expect(source).not.toContain("{smthrs:cache-directory}/tools")
      expect(source).toContain(`cache: S.Cache({ directory: ".flows", outside: true, goBuild: false })`)
    }
    // The one Zig variable in a generated file is the one the step set itself.
    const set = generated([
      job("a", [step("a:1", "zig build test", { env: { ZIG_LOCAL_CACHE_DIR: "/mnt/cache/zig" } })])
    ], packagePath)
    expect(set).toContain(`env: {"ZIG_LOCAL_CACHE_DIR":"/mnt/cache/zig"}`)
    expect(generated([job("a", zig)], packagePath)).not.toContain("ZIG_")
  })

  it("runs a Zig step in the open and observed, with Zig's caches where Zig puts them", () => {
    const source = generated([job("a", [step("a:1", "zig build test")])], packagePath)
    // Nobody names what a Zig build reads: it runs again only when a file its last run read has changed.
    expect(source).toContain(`shell: "bash -e -c 'zig build test'"`)
    expect(source).toContain(`sandbox: "none"`)
    expect(source).toMatch(/observe: \{ ignore: \[.*\] \}/)
    expect(source).not.toContain("env:")
  })
})
