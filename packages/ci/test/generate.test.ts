import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import type { Inventory as InventoryDocument, Job, Step } from "../src/contract/Inventory.ts"
import { Inventory } from "../src/contract/Inventory.ts"
import type { Failure, GeneratedFile, GenerateFiles } from "../src/contract/Parts.ts"
import { forShell, forText } from "../src/generate/Expressions.ts"
import { files } from "../src/generate/index.ts"
import { notesPath, packagePath, workflowPath, workspacePath } from "../src/generate/Render.ts"

const fixture = (name: string): InventoryDocument =>
  Schema.decodeUnknownSync(Inventory)(JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")))

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

const inventory = (jobs: ReadonlyArray<Job>, extra: Partial<InventoryDocument> = {}): InventoryDocument => ({
  version: 1,
  repository: "example/repo",
  commit: "0000000000000000000000000000000000000003",
  toolchains: [],
  jobs,
  ...extra
})

const generate = (document: InventoryDocument): ReadonlyArray<GeneratedFile> => Effect.runSync(files(document))

const content = (generated: ReadonlyArray<GeneratedFile>, path: string): string =>
  generated.find((file) => file.path === path)?.content ?? ""

/** The targets, followed by the notes written as the comments the tests look for. */
const targetsOf = (document: InventoryDocument): string => {
  const generated = generate(document)
  return `${content(generated, packagePath)}\n${content(generated, notesPath).replaceAll("\n- ", "\n// ")}`
}

/** Reads one generated target's source text by its label. */
const declaration = (source: string, label: string): string => {
  const variable = new RegExp(`${JSON.stringify(label).replaceAll(".", "\\.")}: (step\\d+)`).exec(source)?.[1]
  return new RegExp(`const ${variable} = [\\s\\S]*?\\n}\\)`).exec(source)?.[0] ?? ""
}

const failureOf = (document: InventoryDocument): Failure => {
  const exit = Effect.runSyncExit(files(document))
  if (!Exit.isFailure(exit)) throw new Error("expected a failure")
  return exit.cause.reasons.flatMap((reason) => reason._tag === "Fail" ? [reason.error] : [])[0] as Failure
}

describe("expressions", () => {
  it("writes matrix values in place and names the variable GitHub documents for the rest", () => {
    const variant = { node: "22" }
    expect(forShell("use ${{ matrix.node }}", variant)).toBe("use 22")
    expect(forShell("${{env.A}} ${{ secrets.B }}", variant)).toBe("${A} ${B}")
    expect(forShell("${{ github.sha }} ${{ runner.os }}", variant)).toBe("${GITHUB_SHA} ${RUNNER_OS}")
  })

  it("refuses what a shell cannot provide", () => {
    expect(forShell("${{ steps.a.outputs.b }}", {})).toBeUndefined()
    expect(forShell("${{ format('{0}', 1) }}", {})).toBeUndefined()
    expect(forShell("${{ matrix.missing }}", {})).toBeUndefined()
    expect(forShell("${{ matrix.constructor }}", {})).toBeUndefined()
    expect(forShell("${{ env.not-a-name }}", {})).toBeUndefined()
    expect(forShell("${{ vars.SETTING }}", {})).toBeUndefined()
    expect(forShell("${{ github.token }}", {})).toBeUndefined()
  })

  it("allows only matrix values where no shell reads the text", () => {
    expect(forText("dir/${{ matrix.name }}", { name: "a" })).toBe("dir/a")
    expect(forText("${{ github.sha }}", {})).toBeUndefined()
    expect(forText("plain", {})).toBe("plain")
  })
})

describe("files", () => {
  it("has the contract 10 type and returns the workspace, targets and workflow", () => {
    const typed: GenerateFiles = files
    expect(typed).toBe(files)
    const generated = Effect.runSync(files(fixture("inventory.justfile-zig.json")))
    expect(generated.map((file) => file.path).sort()).toEqual([workflowPath, packagePath, workspacePath].sort())
    expect(generated.map((file) => file.path)).not.toContain(notesPath)
  })

  it("gives identical bytes for the same inventory, in any job order", () => {
    const document = fixture("inventory.github-actions-bun.json")
    expect(generate(document)).toEqual(generate(document))
    const zig = fixture("inventory.justfile-zig.json")
    expect(generate({ ...zig, jobs: [...zig.jobs].reverse() })).toEqual(generate(zig))
  })

  it("keeps the commit out of the text, because the text is an input of every target", () => {
    const document = fixture("inventory.justfile-zig.json")
    expect(generate({ ...document, commit: "other" })).toEqual(generate(document))
  })

  it("names a secret and never carries a value", () => {
    const source = targetsOf(fixture("inventory.github-actions-bun.json"))
    expect(source).toContain("secret CODECOV_TOKEN is not passed to the target")
    expect(source).not.toContain("CODECOV_TOKEN\":")
    expect(source).toContain("codecov/codecov-action@v5 has no command to run")
  })
})

describe("what a step becomes", () => {
  it("replays only a step nothing later relies on", () => {
    const source = targetsOf(inventory([job("a", [step("a:1", "bun install"), step("a:2", "bun test")])]))
    expect(declaration(source, "a-1")).toContain("S.Shell.Build(")
    expect(declaration(source, "a-1")).toContain("cache: false")
    expect(declaration(source, "a-1")).toContain(`outFiles: ["//.flows/ci/a-1"]`)
    expect(declaration(source, "a-2")).toContain("S.Shell.Test(")
    expect(declaration(source, "a-2")).toContain(`shell: "bun test"`)
    expect(declaration(source, "a-2")).toMatch(/data: \[repository, step\d+\]/)
  })

  it("treats a needed job as setup only when the jobs share a working tree", () => {
    const shared = targetsOf(inventory([
      job("build", [step("build:1", "make")], { source: "justfile", triggers: [] }),
      job("test", [step("test:1", "make test")], { source: "justfile", triggers: [], needs: ["build"] })
    ]))
    expect(declaration(shared, "build-1")).toContain("S.Shell.Build(")
    const separate = targetsOf(inventory([
      job("build", [step("build:1", "make")]),
      job("test", [step("test:1", "make test")], { needs: ["build"] })
    ]))
    expect(declaration(separate, "build-1")).toContain("S.Shell.Test(")
    expect(declaration(separate, "test-1")).toMatch(/data: \[repository, step0\]/)
  })

  it("runs GitHub scripts as GitHub does and leaves plain commands alone", () => {
    const source = targetsOf(inventory([job("a", [
      step("a:1", "echo 'hi' && false\necho next"),
      step("a:2", "cargo test --locked")
    ])]))
    expect(declaration(source, "a-1")).toContain(
      JSON.stringify(
        `mkdir -p .flows/ci || exit\n: > .flows/ci/a-1 || exit\nbash --noprofile --norc -e -c 'echo '\\''hi'\\'' && false\necho next'`
      )
    )
    expect(declaration(source, "a-2")).toContain(`shell: "cargo test --locked"`)
  })

  it("stops a multi-line recipe at its first failure", () => {
    const source = targetsOf(inventory([job("a", [step("a:1", "false\ntrue")], { source: "makefile", name: "test" })]))
    expect(declaration(source, "a-1")).toContain(JSON.stringify("set -e\nfalse\ntrue"))
  })

  it("runs a recipe with an interpreter line as a file", () => {
    const source = targetsOf(inventory([job("a", [step("a:1", "#!/usr/bin/env bash\n[[ -f x ]]")], {
      source: "justfile",
      name: "test"
    })]))
    expect(declaration(source, "a-1")).toContain("script=$(mktemp) || exit")
    expect(declaration(source, "a-1")).not.toContain("set -e")
  })

  it("passes the runner's variables a command names, and never its token", () => {
    const source = targetsOf(inventory([job("a", [
      step("a:1", "echo ${{ github.sha }} $RUNNER_OS $GITHUB_TOKEN ${GITHUB_REF}", { env: { GITHUB_REF: "main" } }),
      step("a:2", "echo ${{ secrets.DEPLOY_KEY }}")
    ])]))
    expect(declaration(source, "a-1")).toContain(`inheritEnv: ["GITHUB_SHA","RUNNER_OS"]`)
    expect(declaration(source, "a-2")).not.toContain("inheritEnv")
    expect(source).toContain("// a:2: secret DEPLOY_KEY is not passed to the target.")
  })

  it("enters the step's directory and refuses one outside the repository", () => {
    const source = targetsOf(inventory([job("a", [
      step("a:1", "ls", { cwd: "./packages/it's/" }),
      step("a:2", "ls", { cwd: "." }),
      step("a:3", "ls", { cwd: "../other" }),
      step("a:4", "ls", { cwd: "/etc" }),
      step("a:5", "ls", { cwd: "${{ github.workspace }}/x" })
    ])]))
    expect(declaration(source, "a-1")).toContain(JSON.stringify(`cd -- 'packages/it'\\''s' || exit`).slice(1, -1))
    expect(declaration(source, "a-2")).toContain(`shell: "ls"`)
    expect(source).toContain("// a:3: not generated")
    expect(source).toContain("// a:4: not generated")
    expect(source).toContain("// a:5: not generated")
  })

  it("keeps plain environment values and reports the ones only GitHub has", () => {
    const source = targetsOf(inventory([job("a", [
      step("a:1", "ls", { env: { Z: "1", A: "${{ matrix.v }}", B: "${{ github.sha }}" } })
    ], { matrix: [{ v: "x" }] })]))
    expect(declaration(source, "a-1--x")).toContain(`env: {"A":"x","Z":"1"}`)
    expect(source).toContain("// a:1: B is not set")
  })

  it("reports a command it cannot run and keeps the chain around it", () => {
    const source = targetsOf(inventory([job("a", [
      step("a:1", "first"),
      step("a:2", "echo ${{ steps.x.outputs.y }}"),
      step("a:3", "last")
    ])]))
    expect(source).toContain("// a:2: not generated")
    expect(declaration(source, "a-3")).toMatch(/data: \[repository, step0\]/)
  })
})

describe("what counts as CI", () => {
  const labels = (document: InventoryDocument): ReadonlyArray<string> =>
    [...content(generate(document), packagePath).matchAll(/^ {4}"([^"]+)": step/gm)].map((match) => match[1] as string)
  const recipe = (name: string, extra: Partial<Job> = {}): Job =>
    job(`justfile:${name}`, [step(`${name}:1`, `run ${name}`)], { source: "justfile", name, triggers: [], ...extra })

  it("takes GitHub jobs a change triggers, and never a release workflow or a script", () => {
    const document = inventory([
      job("ci", [step("ci:1", "t")], { triggers: ["pull_request"] }),
      job("publish", [step("publish:1", "npm publish")], { triggers: ["release"] }),
      job("nightly", [step("nightly:1", "n")], { triggers: ["schedule", "workflow_dispatch"] }),
      recipe("test")
    ])
    expect(labels(document)).toEqual(["ci-1"])
    expect(targetsOf(document)).toContain("// publish: not generated, it does not run on a change.")
    expect(content(generate(document), workflowPath)).toContain("on:\n  pull_request:\npermissions:")
  })

  it("keeps a needed job that no change triggers", () => {
    const document = inventory([
      job("setup", [step("setup:1", "s")], { triggers: ["workflow_call"] }),
      job("ci", [step("ci:1", "t")], { needs: ["setup"] })
    ])
    expect(labels(document)).toEqual(["setup-1", "ci-1"])
  })

  it("follows a recipe named ci, and leaves destructive and endless recipes out", () => {
    const document = inventory([
      recipe("tidy"),
      recipe("test"),
      recipe("clean"),
      recipe("fuzz"),
      job("justfile:ci", [], {
        source: "justfile",
        name: "ci",
        triggers: [],
        needs: ["justfile:test", "justfile:tidy"]
      })
    ])
    expect(labels(document)).toEqual(["test-1", "tidy-1"])
  })

  it("ignores the workflow it generated itself", () => {
    const own = job("smithers-ci.yml:ci", [step("own:1", "smthrs ci")], { file: workflowPath })
    const document = inventory([own, job("ci", [step("ci:1", "t")])])
    expect(labels(document)).toEqual(["ci-1"])
    expect(targetsOf(document)).not.toContain("smithers-ci.yml:ci")
  })

  it("still replays what a recipe with no commands of its own groups", () => {
    const source = targetsOf(inventory([
      recipe("test"),
      job("justfile:ci", [], { source: "justfile", name: "ci", triggers: [], needs: ["justfile:test"] })
    ]))
    expect(declaration(source, "test-1")).toContain("S.Shell.Test(")
  })

  it("falls back to the conventional check names", () => {
    expect(labels(inventory([recipe("build"), recipe("lint"), recipe("start"), recipe("clean")]))).toEqual([
      "build-1",
      "lint-1"
    ])
  })

  it("refuses when nothing runs on a change", () => {
    expect(failureOf(inventory([recipe("start")]))).toMatchObject({ code: "unsupported" })
  })
})

describe("large graphs", () => {
  const many = (count: number): InventoryDocument =>
    inventory([job("a", Array.from({ length: count }, (_, index) => step(`a:${index}`, "x")))])

  it("lets a small graph declare the repository on each target", () => {
    const source = content(generate(many(32)), packagePath)
    expect(source).toContain(`const repository = S.glob("//**")`)
    expect(source).not.toContain("_repository")
  })

  it("shares one file group above that, so a plan stays small", () => {
    const source = content(generate(many(33)), packagePath)
    expect(source).toContain(`const repository = S.Filegroup({ srcs: [S.glob("//**")] })`)
    expect(source).toContain(`"_repository": repository`)
  })

  it("keeps a step from taking the file group's label", () => {
    const source = content(generate(inventory([job("a", [step("_repository", "x")])])), packagePath)
    expect(source).toMatch(/"_repository-[0-9a-f]+": step0/)
  })
})

describe("the size limit", () => {
  it("refuses targets too large for one PACKAGE.ts", () => {
    const failure = failureOf(inventory([job("a", [step("a:1", `echo ${"x".repeat(1024 * 1024)}`)])]))
    expect(failure).toMatchObject({ code: "unsupported", part: "generate" })
    expect(failure.message).toContain("1048576 bytes")
  })
})

describe("labels", () => {
  it("makes every id a legal, unique target name", () => {
    const source = targetsOf(inventory([job("j", [
      step("1 two", "a"),
      step("1-two", "b"),
      step("ok:x", "c", { name: "Line\none" })
    ])]))
    expect(source).toContain(`"s-1-two": step`)
    expect(source).toMatch(/"s-1-two-[0-9a-f]+": step/)
    expect(source).toContain(`"ok-x": step`)
    expect(source).toContain("// j / Line one")
  })
})

describe("matrix and systems", () => {
  it("declares each distinct variant once and limits it to its system", () => {
    const source = targetsOf(inventory([job("a", [step("a:1", "t ${{ matrix.os }}")], {
      runsOn: "${{ matrix.os }}",
      matrix: [{ os: "ubuntu-latest" }, { os: "macos-latest" }, { os: "ubuntu-latest" }, { os: "windows-latest" }]
    })]))
    expect(declaration(source, "a-1--ubuntu-latest")).toContain(`hosts: ["linux"]`)
    expect(declaration(source, "a-1--macos-latest")).toContain(`hosts: ["darwin"]`)
    expect(declaration(source, "a-1--windows-latest")).toContain(`hosts: ["win32"]`)
    expect(source.match(/"a-1--ubuntu-latest":/g)).toHaveLength(1)
    expect(source).toContain("// a: runs only on Windows")
  })

  it("leaves a runner it does not recognise unrestricted", () => {
    const generated = generate(inventory([job("a", [step("a:1", "t")], { runsOn: "self-hosted" })]))
    expect(declaration(content(generated, packagePath), "a-1")).not.toContain("hosts:")
    expect(content(generated, workflowPath)).toContain(`os: ["self-hosted"]`)
  })

  it("waits only for needed work on the same system", () => {
    const build = job("build", [step("build:1", "b")], {
      runsOn: "${{ matrix.os }}",
      matrix: [{ os: "ubuntu-latest" }, { os: "macos-latest" }]
    })
    const source = targetsOf(inventory([
      build,
      job("linux", [step("linux:1", "l")], { needs: ["build"], runsOn: "ubuntu-latest" }),
      job("any", [step("any:1", "x")], { needs: ["build"] })
    ]))
    const variable = /"build-1--ubuntu-latest": (step\d+)/.exec(source)?.[1]
    expect(declaration(source, "linux-1")).toContain(`data: [repository, ${variable}]`)
    expect(declaration(source, "any-1")).toContain("data: [repository]")
    expect(source).toContain("// any: runs on every system, so it does not wait for build.")
  })

  it("passes a need through a job with nothing to run", () => {
    const source = targetsOf(inventory([
      job("a", [step("a:1", "x")]),
      job("empty", [], { needs: ["a"] }),
      job("c", [step("c:1", "y")], { needs: ["empty"] })
    ]))
    expect(declaration(source, "c-1")).toMatch(/data: \[repository, step0\]/)
  })
})

describe("refusals", () => {
  it("refuses a document that contradicts itself", () => {
    const one = job("a", [step("a:1", "x")])
    expect(failureOf(inventory([one, one]))).toMatchObject({ code: "invalid-document", part: "generate" })
    expect(failureOf(inventory([one, job("b", [step("a:1", "y")])])).message).toContain("Step a:1")
    expect(failureOf(inventory([job("b", [], { needs: ["gone"] })])).message).toContain("needs gone")
    expect(
      failureOf(inventory([
        job("a", [step("a:1", "x")], { needs: ["b"] }),
        job("b", [step("b:1", "y")], { needs: ["a"] })
      ])).message
    ).toContain("cycle")
  })

  it("says so when nothing can run", () => {
    expect(failureOf(inventory([job("a", [])]))).toMatchObject({ code: "unsupported", part: "generate" })
    expect(failureOf(inventory([job("a", [step("a:1", "x")], { runsOn: "windows-latest" })])).message).toContain(
      "Windows"
    )
  })
})

describe("the workspace and workflow", () => {
  it("names the workspace after the repository", () => {
    expect(content(generate(inventory([job("a", [step("a:1", "x")])])), workspacePath)).toContain(
      `S.Workspace("example-repo", {`
    )
    expect(
      content(generate(inventory([job("a", [step("a:1", "x")])], { repository: "///" })), workspacePath)
    ).toContain(`S.Workspace("repository", {`)
  })

  it("runs smthrs on the repository's triggers with its tools", () => {
    const workflow = content(
      generate(inventory([job("a", [step("a:1", "x")], { triggers: ["schedule", "push"], runsOn: "ubuntu-24.04" })], {
        toolchains: [
          { name: "zig", source: "build.zig.zon", version: "0.15.1" },
          { name: "zig", source: "a-later-file", version: "0.14.0" },
          { name: "bun", source: "package.json" },
          { name: "turbo", source: "turbo.json" }
        ]
      })),
      workflowPath
    )
    expect(workflow).toContain("on:\n  push:\npermissions:")
    expect(workflow).toContain(`os: ["ubuntu-24.04"]`)
    expect(workflow).toContain(`mlugg/setup-zig@v2\n        with:\n          version: "0.14.0"`)
    expect(workflow.indexOf("oven-sh/setup-bun@v2")).toBeLessThan(workflow.indexOf("mlugg/setup-zig@v2"))
    expect(workflow).toContain("# turbo (turbo.json) has no known setup action.")
    expect(workflow).toContain(`node-version: "24"`)
    expect(workflow).toContain("smthrs ci '//...' --jobs 1")
    expect(workflow.indexOf("path: .flows/cache")).toBeLessThan(workflow.indexOf("smthrs ci"))
  })

  it("uses the repository's Node and defaults its triggers and runner", () => {
    const workflow = content(
      generate(inventory([job("a", [step("a:1", "x")], { source: "justfile", name: "test", triggers: [] })], {
        toolchains: [{ name: "node", source: ".nvmrc", version: "22.20.0" }]
      })),
      workflowPath
    )
    expect(workflow).toContain("on:\n  pull_request:\n  push:\n")
    expect(workflow).toContain(`os: ["ubuntu-latest"]`)
    expect(workflow).toContain(`node-version: "22.20.0"`)
    expect(workflow).not.toContain(`node-version: "24"`)
  })
})
