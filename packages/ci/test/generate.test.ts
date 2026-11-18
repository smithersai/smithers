import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import type { Ci, Inventory as InventoryDocument, Job, Step } from "../src/contract/Inventory.ts"
import { ci, Inventory, shell } from "../src/contract/Inventory.ts"
import type { Failure, GeneratedFile, GenerateFiles } from "../src/contract/Parts.ts"
import { shardOf } from "../src/contract/Shard.ts"
import { labelsOf, path as targetMapPath, TargetMap } from "../src/contract/TargetMap.ts"
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

/** The document exactly as given, as the CI: what the generator makes of these jobs and no others. */
const given = (document: InventoryDocument): Ci => document as Ci

const generate = (document: InventoryDocument): ReadonlyArray<GeneratedFile> => Effect.runSync(files(given(document)))

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
  const exit = Effect.runSyncExit(files(given(document)))
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
    const generated = Effect.runSync(typed(given(fixture("inventory.justfile-zig.json"))))
    expect(generated.map((file) => file.path).sort()).toEqual(
      [workflowPath, packagePath, workspacePath, targetMapPath].sort()
    )
    expect(generated.map((file) => file.path)).not.toContain(notesPath)
  })

  it("writes the target map: the label of every step, in every variant, one target at a time", () => {
    const document = inventory([
      job("a", [step("a:1", "bun install"), step("a:2", "bun test ${{ matrix.shard }}")], {
        matrix: [{ shard: "1" }, { shard: "2" }]
      }),
      job("b", [step("b:1", "bun lint")], { needs: ["a"] })
    ])
    const generated = generate(document)
    const map = Schema.decodeUnknownSync(Schema.fromJsonString(TargetMap))(content(generated, targetMapPath))
    expect(map.maxJobs).toBe(1)
    expect(map.targets).toHaveLength(5)
    const declared = [...content(generated, packagePath).matchAll(/^ {4}"([^"]+)": step/gm)].map((match) =>
      `//:${match[1]}`
    )
    expect(map.targets.map((entry) => entry.label).sort()).toEqual([...declared].sort())
    expect(labelsOf(map, "b", "b:1", {})).toEqual(["//:b-1"])
    const first = labelsOf(map, "a", "a:2", { shard: "1" })
    const second = labelsOf(map, "a", "a:2", { shard: "2" })
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(first).not.toEqual(second)
    expect(labelsOf(map, "a", "a:2", { shard: "3" })).toEqual([])
  })

  it("sends results to the shared cache only when one is named, and never writes its token", () => {
    const document = inventory([job("a", [step("a:1", "x")])])
    const plain = content(generate(document), workflowPath)
    expect(plain).not.toContain("SMITHERS_CACHE")
    const cached = content(Effect.runSync(files(given(document), { cache: "https://cache.example.com" })), workflowPath)
    expect(cached).toContain(`          SMITHERS_CACHE_URL: "https://cache.example.com"\n`)
    expect(cached).toContain("          SMITHERS_CACHE_TOKEN: ${{ secrets.SMITHERS_CACHE_TOKEN }}\n")
    expect(cached.replace(/ {8}env:\n.*\n.*\n/, "")).toBe(plain)
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
    expect(declaration(source, "a-2")).toContain(`shell: "bash -e -c 'bun test'"`)
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

  it("runs every step under the shell the baseline runs it under, whatever its source", () => {
    const source = targetsOf(inventory([
      job("a", [step("a:1", "echo 'hi' && false\necho next"), step("a:2", "source scripts/check.sh")]),
      job("b", [step("b:1", "false\ntrue")], { source: "makefile", name: "test" }),
      job("c", [step("c:1", "#!/usr/bin/env bash\n[[ -f x ]]")], { source: "justfile", name: "test" })
    ]))
    expect(declaration(source, "a-1")).toContain(
      JSON.stringify(
        `mkdir -p .flows/ci || exit\n: > .flows/ci/a-1 || exit\nbash -e -c 'echo '\\''hi'\\'' && false\necho next'`
      )
    )
    // A command of plain words is no exception: `source` and `time` are not `/bin/sh` words.
    expect(declaration(source, "a-2")).toContain(`shell: "${shell.join(" ")} 'source scripts/check.sh'"`)
    expect(declaration(source, "b-1")).toContain(JSON.stringify("bash -e -c 'false\ntrue'"))
    expect(declaration(source, "c-1")).toContain(JSON.stringify("bash -e -c '#!/usr/bin/env bash\n[[ -f x ]]'"))
    expect(source).not.toContain("mktemp")
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
    expect(declaration(source, "a-2")).toContain(`shell: "bash -e -c 'ls'"`)
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
  /** These tests give the generator what `Inventory.ci` makes of a whole inventory, as the program does. */
  const labels = (document: InventoryDocument): ReadonlyArray<string> =>
    [...content(generate(ci(document)), packagePath).matchAll(/^ {4}"([^"]+)": step/gm)].map((match) =>
      match[1] as string
    )
  const recipe = (name: string, extra: Partial<Job> = {}): Job =>
    job(`justfile:${name}`, [step(`${name}:1`, `run ${name}`)], {
      source: "justfile",
      file: "justfile",
      name,
      triggers: [],
      ...extra
    })

  it("takes GitHub jobs a change triggers, and never a release workflow or a script", () => {
    const document = inventory([
      job("ci", [step("ci:1", "t")], { triggers: ["pull_request"] }),
      job("publish", [step("publish:1", "npm publish")], { triggers: ["release"] }),
      job("nightly", [step("nightly:1", "n")], { triggers: ["schedule", "workflow_dispatch"] }),
      recipe("test")
    ])
    expect(labels(document)).toEqual(["ci-1"])
    expect(targetsOf(ci(document))).not.toContain("publish")
    expect(content(generate(ci(document)), workflowPath)).toContain("on:\n  pull_request:\npermissions:")
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
        file: "justfile",
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
    expect(targetsOf(ci(document))).not.toContain("smithers-ci.yml:ci")
  })

  it("still replays what a recipe with no commands of its own groups", () => {
    const source = targetsOf(ci(inventory([
      recipe("test"),
      job("justfile:ci", [], {
        source: "justfile",
        file: "justfile",
        name: "ci",
        triggers: [],
        needs: ["justfile:test"]
      })
    ])))
    expect(declaration(source, "test-1")).toContain("S.Shell.Test(")
  })

  it("refuses recipes with conventional names when no `ci` recipe says they are the CI", () => {
    const document = inventory([recipe("build"), recipe("lint"), recipe("start"), recipe("clean")])
    expect(failureOf(ci(document))).toMatchObject({ code: "unsupported", message: "No job of the CI has a command." })
  })

  it("generates every job it is given, whatever its name or triggers", () => {
    expect(labels(inventory([recipe("ci", { needs: ["justfile:fuzz"] }), recipe("fuzz")]))).toEqual(["fuzz-1", "ci-1"])
    const asGiven = content(generate(inventory([recipe("start"), recipe("clean")])), packagePath)
    expect(asGiven).toContain(`"start-1": step`)
    expect(asGiven).toContain(`"clean-1": step`)
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

describe("a step that names what it reads", () => {
  const parts: ReadonlyArray<Step> = [
    step("a:2:ui", "pnpm --filter=ui run test", { inputs: ["packages/ui/**", "*"], from: "a:2" }),
    step("a:2:web", "pnpm --filter=ui --filter=web run test", {
      inputs: ["*", "packages/ui/**", "packages/web/**"],
      from: "a:2"
    })
  ]
  const split = (tail: ReadonlyArray<Step> = []) =>
    inventory([job("a", [step("a:1", "pnpm install"), ...parts, ...tail])])

  it("declares the step's inputs in place of the whole repository, and holds the target to them", () => {
    const source = targetsOf(inventory([job("a", parts)]))
    expect(declaration(source, "a-2-ui")).toContain("S.Shell.Test(")
    expect(declaration(source, "a-2-ui")).toContain(`data: [S.glob("//*"), S.glob("//packages/ui/**")]`)
    expect(declaration(source, "a-2-web")).toContain(
      `data: [S.glob("//*"), S.glob("//packages/ui/**"), S.glob("//packages/web/**")]`
    )
    // A read outside the inputs must fail the target, so it runs confined to them.
    expect(declaration(source, "a-2-ui")).toContain("sandbox: { network: true }")
    // A step with no inputs still reads everything, unconfined.
    const whole = declaration(targetsOf(inventory([job("b", [step("b:1", "make test")])])), "b-1")
    expect(whole).toMatch(/data: \[repository\]/)
    expect(whole).toContain(`sandbox: "none"`)
  })

  it("keeps the whole repository for a step that follows another in its working tree", () => {
    // The install wrote files the package steps read, and nothing says which files it read to write them.
    const source = targetsOf(split())
    // The setup step always runs and declares no files.
    expect(declaration(source, "a-1")).toMatch(/data: \[\]/)
    expect(declaration(source, "a-1")).toContain(`sandbox: "none"`)
    for (const label of ["a-2-ui", "a-2-web"]) {
      expect(declaration(source, label)).toContain("S.Shell.Test(")
      expect(declaration(source, label)).toContain("data: [repository, step0]")
      expect(declaration(source, label)).toContain(`sandbox: "none"`)
    }
    expect(source).not.toContain("S.glob(\"//packages/")
    // Recipes share one working tree, so a recipe follows the recipe it needs.
    const recipes = targetsOf(inventory([
      job("build", [step("build:1", "make")], { source: "justfile", triggers: [] }),
      job("test", [step("test:1", "make test", { inputs: ["src/**"], from: "test:1" })], {
        source: "justfile",
        triggers: [],
        needs: ["build"]
      })
    ]))
    expect(declaration(recipes, "test-1")).toContain("data: [repository, step0]")
    expect(declaration(recipes, "test-1")).toContain(`sandbox: "none"`)
    // GitHub jobs run on separate machines: a needed job left nothing in this job's checkout.
    const hosted = targetsOf(inventory([
      job("build", [step("build:1", "make")]),
      job("test", [step("test:1", "make test", { inputs: ["src/**"], from: "test:1" })], { needs: ["build"] })
    ]))
    expect(declaration(hosted, "test-1")).toContain(`data: [S.glob("//src/**"), step0]`)
    expect(declaration(hosted, "test-1")).toContain("sandbox: { network: true }")
  })

  it("places steps split from one step side by side, and the next step after all of them", () => {
    const last = targetsOf(split())
    // Neither relies on the other: both follow the install, and both can be replayed.
    expect(declaration(last, "a-2-ui")).toMatch(/, step0\]/)
    expect(declaration(last, "a-2-web")).toMatch(/, step0\]/)
    expect(declaration(last, "a-2-web")).not.toContain("step1")
    const followed = targetsOf(split([step("a:3", "pnpm run report")]))
    expect(declaration(followed, "a-3")).toMatch(/data: \[repository, step1, step2\]/)
    // A later step relies on them, so they always run, unconfined, and declare no files.
    expect(declaration(followed, "a-2-ui")).toContain("S.Shell.Build(")
    expect(declaration(followed, "a-2-ui")).toMatch(/data: \[step0\]/)
    expect(declaration(followed, "a-2-ui")).toContain(`sandbox: "none"`)
    expect(declaration(followed, "a-2-web")).toContain("cache: false")
  })

  it("groups only neighbours split from the same step", () => {
    const source = targetsOf(inventory([job("a", [
      step("a:1:x", "x", { inputs: ["x/**"], from: "a:1" }),
      step("a:2", "y", { inputs: ["y/**"], from: "a:2" }),
      step("a:3:x", "z", { inputs: ["x/**"], from: "a:1" })
    ])]))
    expect(declaration(source, "a-2")).toMatch(/data: \[step0\]/)
    // The last step follows only the step before it, and reads what both earlier steps wrote.
    expect(declaration(source, "a-3-x")).toContain("data: [repository, step1]")
  })

  it("reads the whole repository when an input is every file", () => {
    const source = targetsOf(inventory([job("a", [step("a:1", "x", { inputs: ["**"], from: "a:1" })])]))
    expect(declaration(source, "a-1")).toMatch(/data: \[repository\]/)
    expect(declaration(source, "a-1")).toContain(`sandbox: "none"`)
  })

  it("skips a split step it cannot generate and keeps its neighbours", () => {
    const source = targetsOf(inventory([job("a", [
      step("a:1", "setup"),
      step("a:2:x", "x ${{ steps.a.outputs.b }}", { inputs: ["x/**"], from: "a:2" }),
      step("a:2:y", "y", { inputs: ["y/**"], from: "a:2" }),
      step("a:3:z", "z ${{ steps.a.outputs.b }}", { inputs: ["z/**"], from: "a:3" }),
      step("a:4", "last")
    ])]))
    expect(source).toContain("a:2:x: not generated")
    expect(declaration(source, "a-2-y")).toMatch(/data: \[step0\]/)
    // The step after a group that made nothing follows the last step that was made.
    expect(declaration(source, "a-4")).toMatch(/data: \[repository, step1\]/)
  })

  it("declares the whole repository for every target when the inputs do not fit in one PACKAGE.ts", () => {
    const inputs = Array.from({ length: 4000 }, (_, index) => `packages/${"p".repeat(200)}-${index}/**`)
    const steps = Array.from(
      { length: 3 },
      (_, index) => step(`a:1:${index}`, "true", { inputs, from: "a:1" })
    )
    const source = content(generate(inventory([job("a", steps)])), packagePath)
    expect(source).not.toContain("S.glob(\"//packages/")
    expect(source.match(/data: \[repository\]/g)).toHaveLength(3)
    // No target is held to inputs it does not declare.
    expect(source).not.toContain("sandbox: {")
  })

  it("gives a step that was split one target map entry per target, each naming the original step", () => {
    const document = inventory([job("a", [
      step("a:1", "pnpm install"),
      step("a:2:ui", "pnpm --filter=ui run test", { inputs: ["packages/ui/**"], from: "a:2" }),
      step("a:2:web", "pnpm --filter=web run test", { inputs: ["packages/web/**"], from: "a:2" }),
      step("a:3", "pnpm run report", { inputs: ["*"], from: "a:3" })
    ])])
    const map = Schema.decodeUnknownSync(Schema.fromJsonString(TargetMap))(content(generate(document), targetMapPath))
    expect(labelsOf(map, "a", "a:2", {})).toEqual(["//:a-2-ui", "//:a-2-web"])
    expect(labelsOf(map, "a", "a:1", {})).toEqual(["//:a-1"])
    // A step that kept its command names itself.
    expect(labelsOf(map, "a", "a:3", {})).toEqual(["//:a-3"])
    expect(labelsOf(map, "a", "a:2:ui", {})).toEqual([])
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

  const labelsOfSteps = (document: InventoryDocument): ReadonlyArray<string> =>
    [...content(generate(document), packagePath).matchAll(/^ {4}"([^"]+)": step/gm)].map((match) => match[1] as string)

  it("keeps labels apart whatever their letter case", () => {
    // Smithers build refuses a package holding `ci-Build` and `ci-build`.
    const labels = labelsOfSteps(inventory([job("ci", [
      step("ci:Build", "one"),
      step("ci:build", "two"),
      step("ci:BUILD", "three"),
      step("_Repository", "four")
    ])]))
    expect(labels[0]).toBe("ci-Build")
    expect(labels[1]).toMatch(/^ci-build-[0-9a-f]+$/)
    expect(labels[2]).toMatch(/^ci-BUILD-[0-9a-f]+$/)
    expect(labels[3]).toMatch(/^_Repository-[0-9a-f]+$/)
    expect(new Set(labels.map((label) => label.toLowerCase())).size).toBe(4)
  })

  it("never gives two steps one label, even when an id is written to equal another's suffixed label", () => {
    // `ci:x-y` collides with `ci:x y` and would be suffixed to the label the first step already has.
    const taken = `ci:x-y-${shardOf("ci:x-y\n[]", 0x1_0000_0000).toString(16)}`
    const document = inventory([
      job("j1", [step(taken, "false")]),
      job("j2", [step("ci:x y", "true")]),
      job("j3", [step("ci:x-y", "true")])
    ])
    const labels = labelsOfSteps(document)
    expect(labels.slice(0, 2)).toEqual([taken.replace(":", "-"), "ci-x-y"])
    expect(labels[2]).toMatch(/^ci-x-y-[0-9a-f]+$/)
    expect(new Set(labels).size).toBe(3)
    // Every step keeps its own target: none replaced another's.
    const map = Schema.decodeUnknownSync(Schema.fromJsonString(TargetMap))(content(generate(document), targetMapPath))
    expect(map.targets.map((entry) => entry.step)).toEqual([taken, "ci:x y", "ci:x-y"])
    expect(new Set(map.targets.map((entry) => entry.label)).size).toBe(3)
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

  it("installs the version a file pins when the CI's workflow holds none, and says the workflow's own is not kept", () => {
    // What the importer writes for `node-version: ${{ matrix.node }}` with `node: [18, 20]`, beside an `.nvmrc`.
    const generated = generate(inventory(
      [job("ci.yml:test", [step("t:1", "node test.js")], { matrix: [{ node: "18" }, { node: "20" }] })],
      {
        toolchains: [
          { name: "node", source: ".github/workflows/ci.yml" },
          { name: "node", source: ".nvmrc", version: "20" }
        ]
      }
    ))
    // The entry with no version sorts first; it no longer wins over the one that has a version.
    expect(content(generated, workflowPath)).toContain(
      `      - uses: actions/setup-node@v4\n        with:\n          node-version: "20"\n`
    )
    expect(content(generated, notesPath)).toContain(
      "- node: .github/workflows/ci.yml sets it up with a version this inventory does not hold: none is written, " +
        "or it is worked out when the workflow runs, as a matrix value is. Every target runs with node 20 (.nvmrc).\n"
    )
    expect(content(generated, packagePath)).toContain(`// Not reproduced from the original CI: see ${notesPath}`)
  })

  it("installs one version of each tool and names every other version the CI's own files hold", () => {
    const generated = generate(inventory([job("ci.yml:test", [step("t:1", "make")])], {
      toolchains: [
        // Two jobs of the CI's workflow pin different versions: the inventory does not say which job has which.
        { name: "node", source: ".github/workflows/ci.yml", version: "18" },
        { name: "node", source: ".github/workflows/ci.yml", version: "20" },
        // A pin file is less trusted than what the CI itself installs, so its version is no loss.
        { name: "node", source: ".nvmrc", version: "22" },
        // A version still written as an expression is not one to install.
        { name: "python", source: ".github/workflows/ci.yml", version: "${{ matrix.python }}" },
        // Two pin files disagree.
        { name: "zig", source: "build.zig.zon", version: "0.15.1" },
        { name: "zig", source: "a-later-file", version: "0.14.0" },
        // Only workflows that are not CI name Go: the first version among them is used, and nothing is noted.
        { name: "go", source: ".github/workflows/nightly.yml" },
        { name: "go", source: ".github/workflows/release.yml", version: "1.22" },
        { name: "go", source: ".github/workflows/weekly.yml", version: "1.21" },
        // A pin file names Bun with no version: a workflow that is not CI is not asked for one.
        { name: "bun", source: "package.json" },
        { name: "bun", source: ".github/workflows/release.yml", version: "1.2.0" }
      ]
    }))
    const workflow = content(generated, workflowPath)
    expect(workflow).toContain(`      - uses: oven-sh/setup-bun@v2\n      - uses: actions/setup-go@v5\n`)
    expect(workflow).toContain(`          go-version: "1.22"\n      - uses: actions/setup-node@v4\n`)
    expect(workflow).toContain(`          node-version: "18"\n      - uses: actions/setup-python@v5\n      - uses:`)
    expect(workflow).toContain(`          version: "0.14.0"\n`)
    expect(workflow).not.toContain("${{ matrix.python }}")
    expect(content(generated, notesPath).split("\n").filter((line) => line.startsWith("- "))).toEqual([
      "- node 20 (.github/workflows/ci.yml) is not installed: every target runs with node 18 " +
      "(.github/workflows/ci.yml).",
      "- python: .github/workflows/ci.yml sets it up with a version this inventory does not hold: none is written, " +
      "or it is worked out when the workflow runs, as a matrix value is. Every target runs with the version its " +
      "setup action installs by default.",
      "- zig 0.15.1 (build.zig.zon) is not installed: every target runs with zig 0.14.0 (a-later-file)."
    ])
  })

  it("installs the read sandbox on the runner when a target is held to its inputs, and only then", () => {
    const held = inventory([job("a", [step("a:1", "x", { inputs: ["src/**"], from: "a:1" })])])
    const workflow = content(generate(held), workflowPath)
    expect(content(generate(held), packagePath)).toContain("sandbox: { network: true }")
    // Linux targets are confined by bubblewrap, which an Ubuntu runner does not have.
    expect(workflow).toContain("        if: runner.os == 'Linux'\n")
    expect(workflow).toContain("apt-get install -y -qq --no-install-recommends bubblewrap")
    expect(workflow).toContain("sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0")
    expect(workflow.indexOf("bubblewrap\n")).toBeLessThan(workflow.indexOf("smthrs ci"))
    // No target is confined: nothing to install.
    const open = content(generate(inventory([job("a", [step("a:1", "x")])])), workflowPath)
    expect(open).not.toContain("bubblewrap")
    // Inputs too large for one PACKAGE.ts: every target runs in the open, so the step is left out.
    const inputs = Array.from({ length: 4000 }, (_, index) => `packages/${"p".repeat(300)}-${index}/**`)
    const large = generate(inventory([job("a", [step("a:1", "x", { inputs, from: "a:1" })])]))
    expect(content(large, packagePath)).not.toContain("sandbox: {")
    expect(content(large, workflowPath)).not.toContain("bubblewrap")
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
