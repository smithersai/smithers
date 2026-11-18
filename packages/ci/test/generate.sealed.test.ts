import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import type { Ci, Inventory as InventoryDocument, Job, Step } from "../src/contract/Inventory.ts"
import { toolCache } from "../src/contract/Inventory.ts"
import type { GeneratedFile } from "../src/contract/Parts.ts"
import { files } from "../src/generate/index.ts"
import { compiledCode, packagePath, workflowPath, workspacePath } from "../src/generate/Render.ts"
import { heldChanged } from "../src/generate/Steps.ts"

const step = (id: string, command: string, extra: Partial<Step> = {}): Step => ({
  id,
  command,
  cwd: "",
  env: {},
  secrets: [],
  ...extra
})

const job = (id: string, steps: ReadonlyArray<Step>, extra: Partial<Job> = {}): Job => ({
  id,
  source: "github-actions",
  file: ".github/workflows/ci.yml",
  name: id,
  needs: [],
  triggers: ["push"],
  matrix: [],
  steps,
  unsupported: [],
  ...extra
})

const recipe = (name: string, steps: ReadonlyArray<Step>, needs: ReadonlyArray<string> = []): Job =>
  job(`justfile:${name}`, steps, { source: "justfile", file: "Justfile", name, triggers: [], needs })

/** The targets made of exactly these jobs, taken as the CI. */
const generate = (jobs: ReadonlyArray<Job>): ReadonlyArray<GeneratedFile> => {
  const document: InventoryDocument = {
    version: 1,
    repository: "example/repo",
    commit: "0000000000000000000000000000000000000003",
    toolchains: [],
    jobs
  }
  return Effect.runSync(files(document as Ci))
}

const content = (generated: ReadonlyArray<GeneratedFile>, path: string): string =>
  generated.find((file) => file.path === path)?.content ?? ""

/** One generated target's source text, by its label. */
const declaration = (source: string, label: string): string => {
  const variable = new RegExp(`${JSON.stringify(label).replaceAll(".", "\\.")}: (step\\d+)`).exec(source)?.[1]
  return new RegExp(`const ${variable} = [\\s\\S]*?\\n}\\)`).exec(source)?.[0] ?? ""
}

/** The script a target's `shell` field holds. */
const scriptOf = (source: string, label: string): string =>
  JSON.parse(/^ {2}shell: (".*"),?$/m.exec(declaration(source, label))?.[1] ?? `""`) as string

/** A step that only runs Zig, as the splitter writes it. */
const zig = (id: string, inputs: ReadonlyArray<string>, extra: Partial<Step> = {}): Step =>
  step(id, "zig build test", {
    inputs,
    tools: ["zig"],
    sealed: true,
    env: { ZIG_LOCAL_CACHE_DIR: `${toolCache}/zig/local` },
    ...extra
  })

describe("a step that names the programs it starts", () => {
  it("names each program in its target, and the workspace requires them", () => {
    const generated = generate([
      job("a", [step("a:1", "zig build test", { inputs: ["src/**"], tools: ["zig", "cmake", "zig"] })])
    ])
    const source = content(generated, packagePath)
    expect(declaration(source, "a-1")).toContain(`  tools: [S.Host.bin("cmake"), S.Host.bin("zig")],`)
    expect(content(generated, workspacePath)).toContain(`host: S.Host({ bins: ["bash", "cmake", "sh", "zig"] })`)
  })

  it("names nothing for a step that names none", () => {
    const generated = generate([job("a", [step("a:1", "true")])])
    expect(content(generated, packagePath)).not.toContain("tools:")
    expect(content(generated, workspacePath)).toContain(`host: S.Host({ bins: ["bash", "sh"] })`)
  })
})

describe("a step that keeps a tool's cache", () => {
  it("has the workflow save the tool cache with the results", () => {
    const kept = content(generate([job("a", [zig("a:1", ["src/**"])])]), workflowPath)
    expect(kept).toContain(`          path: |\n            .flows/cache\n            ${toolCache}\n`)
    // A step can name the tool cache itself.
    const whole = content(generate([job("a", [step("a:1", "true", { env: { CACHE: toolCache } })])]), workflowPath)
    expect(whole).toContain(`            ${toolCache}\n`)
  })

  it("leaves the workflow as it was for every other step", () => {
    const plain = content(
      generate([job("a", [step("a:1", "true", { env: { CACHE: `${toolCache}-other`, CI: "1" } })])]),
      workflowPath
    )
    expect(plain).toContain(`          path: |\n            .flows/cache\n            ${compiledCode}\n`)
    expect(plain).not.toContain(toolCache)
  })
})

describe("a sealed step", () => {
  const inputs = ["build.zig", "src/a.zig", "data/**"]

  it("stays held to its inputs after a step that names nothing, which then checks it left them alone", () => {
    const generated = generate([
      recipe("tidy", [step("justfile:tidy:1", "./tidy.sh", { cwd: "tools" })]),
      recipe("test", [zig("justfile:test:1", inputs)], ["justfile:tidy"])
    ])
    const source = content(generated, packagePath)
    const test = declaration(source, "justfile-test-1")
    expect(test).toContain(`sandbox: { network: true }`)
    expect(test).toContain(`data: [S.glob("//build.zig"), S.glob("//data/**"), S.glob("//src/a.zig"), step0]`)
    expect(scriptOf(source, "justfile-test-1")).toBe(`bash -e -c 'zig build test'`)
    // The step before it runs in a subshell from its own directory, then the files are read again from the root.
    expect(scriptOf(source, "justfile-tidy-1").split("\n")).toEqual([
      "mkdir -p .flows/ci || exit",
      ": > .flows/ci/justfile-tidy-1 || exit",
      "smithers_ci_files() {",
      `  tr '\\n' '\\0' <<'SMITHERS_CI_HELD' | xargs -0 git -c core.quotePath=false ls-files --cached --others --exclude-standard -- | while IFS= read -r smithers_ci_file; do if [ -f "$smithers_ci_file" ]; then printf '%s\\n' "$smithers_ci_file"; fi; done`,
      ":(literal)build.zig",
      ":(glob)data/**",
      ":(literal)src/a.zig",
      "SMITHERS_CI_HELD",
      "}",
      "smithers_ci_held() {",
      "  smithers_ci_files",
      "  smithers_ci_files | git hash-object --no-filters --stdin-paths",
      "}",
      "smithers_ci_before=$(smithers_ci_held)",
      "(",
      "cd -- 'tools' || exit",
      "bash -e -c './tidy.sh'",
      ")",
      "smithers_ci_status=$?",
      `if [ "$smithers_ci_before" != "$(smithers_ci_held)" ]; then`,
      `  echo '${heldChanged}' >&2`,
      "  exit 1",
      "fi",
      `exit "$smithers_ci_status"`
    ])
    // The check lists files with git, so the workspace requires it.
    expect(content(generated, workspacePath)).toContain(`host: S.Host({ bins: ["bash", "git", "sh", "zig"] })`)
  })

  it("has every target that ran before it check, each for all the sealed targets after it, and none that cannot write", () => {
    const source = content(
      generate([
        // `lint` is one step with no inputs: its target runs in the open and nothing relies on it.
        job("lint", [step("lint:1", "eslint .")]),
        // `types` is held to its inputs, so it cannot write.
        job("types", [step("types:1", "tsc", { inputs: ["src/**"] })]),
        job("test", [step("test:1", "./prepare.sh"), zig("test:2", ["src/a.zig"]), zig("test:3", ["src/b.zig"])], {
          needs: ["lint", "types"]
        }),
        // A second job that needs `lint` reaches it again through `test`.
        job("after", [step("after:1", "true"), zig("after:2", ["src/c.zig"])], { needs: ["test", "lint"] })
      ]),
      packagePath
    )
    const held = (label: string): ReadonlyArray<string> =>
      scriptOf(source, label).split("\n").filter((line) => line.startsWith(":(")).map((line) =>
        line.slice(":(literal)".length)
      )
    // `test:2` always runs, because `test:3` follows it: its result is never reused, so nothing is checked for it.
    expect(held("lint-1")).toEqual(["src/b.zig", "src/c.zig"])
    expect(held("test-1")).toEqual(["src/b.zig", "src/c.zig"])
    // It runs in the open itself, so it checks for the sealed steps after it.
    expect(held("test-2")).toEqual(["src/b.zig", "src/c.zig"])
    expect(held("after-1")).toEqual(["src/c.zig"])
    // A target held to its inputs cannot write: `types`, and the last step of `test`.
    expect(held("types-1")).toEqual([])
    expect(held("test-3")).toEqual([])
    expect(scriptOf(source, "types-1")).toBe(`bash -e -c 'tsc'`)
    expect(scriptOf(source, "test-3")).toBe(`bash -e -c 'zig build test'`)
    // A target nothing relies on has no marker to write before it checks.
    expect(scriptOf(source, "lint-1").split("\n")[0]).toBe("smithers_ci_files() {")
    // The last sealed step of each job declares its inputs.
    expect(declaration(source, "test-3")).toContain(`S.glob("//src/b.zig")`)
    expect(declaration(source, "after-2")).toContain(`S.glob("//src/c.zig")`)
  })

  it("asks no check of a step when it is the first in its working tree, or when the steps before it name their writes", () => {
    const first = content(generate([job("a", [zig("a:1", inputs)])]), packagePath)
    expect(first).not.toContain("smithers_ci_held")
    const known = generate([
      job("a", [step("a:1", "make gen", { inputs: ["spec/**"], outputs: ["gen/**"] }), zig("a:2", inputs)])
    ])
    expect(content(known, packagePath)).not.toContain("smithers_ci_held")
    expect(content(known, workspacePath)).toContain(`host: S.Host({ bins: ["bash", "sh", "zig"] })`)
  })

  it("declares the whole repository when it reads all of it, or an input has a line break", () => {
    for (const reads of [["**"], ["src/a\nb.zig"]]) {
      const source = content(generate([job("a", [step("a:1", "./prepare.sh"), zig("a:2", reads)])]), packagePath)
      expect(declaration(source, "a-2")).toContain(`data: [repository, step0]`)
      expect(source).not.toContain("smithers_ci_held")
    }
  })

  it("checks nothing when the targets are too large to declare their inputs", () => {
    const many = Array.from({ length: 30_000 }, (_, index) => `src/some/long/directory/name/for/a/file-${index}.zig`)
    const generated = generate([job("a", [step("a:1", "./prepare.sh"), zig("a:2", many)])])
    const source = content(generated, packagePath)
    // Every target declares the whole repository and runs in the open: no key is made of a file a step could rewrite.
    expect(declaration(source, "a-2")).toContain(`data: [repository, step0]`)
    expect(source).not.toContain("smithers_ci_held")
    expect(content(generated, workspacePath)).toContain(`host: S.Host({ bins: ["bash", "sh", "zig"] })`)
  })
})
