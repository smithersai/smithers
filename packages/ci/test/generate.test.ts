import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"
import type { Ci, Inventory as InventoryDocument, Job, Step } from "../src/contract/Inventory.vibe"
import {
  ci,
  commitNote,
  commitQuestion,
  eventsVariable,
  Inventory,
  runnerEntry,
  runnerSoftware,
  runVariables,
  script,
  shell
} from "../src/contract/Inventory.vibe"
import {
  type Failure,
  type GeneratedFile,
  type GenerateFiles,
  type GenerateOptions,
  writtenFiles
} from "../src/contract/Parts.vibe"
import { shardOf } from "../src/contract/Shard.vibe"
import { labelsOf, path as targetMapPath, TargetMap } from "../src/contract/TargetMap.vibe"
import { forShell, forText } from "../src/generate/Expressions.vibe"
import { files } from "../src/generate/index.vibe"
import {
  actionRefs,
  compiledCode,
  contentStore,
  keptFiles,
  legsPath,
  machinesDirectory,
  noSharedCache,
  notesPath,
  packagePath,
  packIgnorePath,
  stateDirectory,
  workflowPath,
  workspacePath
} from "../src/generate/Render.ts"
import { compiledCode as replayed } from "../src/replay/index.vibe"

const releaseVersion: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version

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

const generate = (document: InventoryDocument, options?: GenerateOptions): ReadonlyArray<GeneratedFile> =>
  Effect.runSync(files(given(document), options))

// The workflow's comments as one text, as a person reads them across the lines they are wrapped on.
const commentsOf = (workflow: string): string =>
  workflow.split("\n").filter((line) => line.trimStart().startsWith("#")).map((line) => line.trim().replace(/^# ?/, ""))
    .join(" ")

// The command of the workflow's step that runs smthrs.
const smthrsRun = (workflow: string): string =>
  String(
    (parseYaml(workflow) as { jobs: { ci: { steps: ReadonlyArray<Record<string, unknown>> } } }).jobs.ci.steps.find((
      entry
    ) => String(entry["run"]).includes("smthrs ci"))?.["run"]
  )

const content = (generated: ReadonlyArray<GeneratedFile>, path: string): string =>
  generated.find((file) => file.path === path)?.content ?? ""

/** The targets, followed by the notes written as the comments the tests look for. */
// What a target with runner text passes on with its value in the key: where the event file is, with `more`.
const passedOn = (more: ReadonlyArray<string> = []): ReadonlyArray<string> =>
  [...new Set(["GITHUB_EVENT_PATH", eventsVariable, ...more])].sort()

// What it passes on with its value out of the key, unless its run used one: what a run gives, and where the machine
// has a runner's software.
const runGiven: ReadonlyArray<string> = [...runVariables, ...runnerSoftware].sort()

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
    expect(forShell("${{env.A}} ${{ env.B }}", variant)).toBe("${A} ${B}")
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
    // A target is given no secret, so a command that names one has no shell form.
    expect(forShell("${{ secrets.B }}", {})).toBeUndefined()
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
      [workflowPath, workspacePath, packIgnorePath, targetMapPath].sort()
    )
    expect(generated.map((file) => file.path)).not.toContain(notesPath)
    // The target map is the program's own document: it is in the list and is not written into a repository.
    expect(writtenFiles(generated).map((file) => file.path).sort()).toEqual(
      [workflowPath, workspacePath, packIgnorePath].sort()
    )
    expect(generated.find((file) => file.path === targetMapPath)?.written).toBe(false)
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
    // The shards run on one runner of the generated workflow, where they share its ports and its `/tmp`.
    expect(map.maxJobs).toBe(1)
    expect(map.targets).toHaveLength(5)
    const declared = [...content(generated, packagePath).matchAll(/^ {4}"([^"]+)": step/gm)].map((match) =>
      `//:${match[1]}`
    )
    // Each shard is a job of its own on GitHub, so each installs for itself, on its own machine.
    expect(declared).toHaveLength(5)
    expect([...new Set(map.targets.map((entry) => entry.label))].sort()).toEqual([...declared].sort())
    expect(labelsOf(map, "a", "a:1", { shard: "2" })).not.toEqual(labelsOf(map, "a", "a:1", { shard: "1" }))
    expect(labelsOf(map, "b", "b:1", {})).toEqual(["//:b-1"])
    const first = labelsOf(map, "a", "a:2", { shard: "1" })
    const second = labelsOf(map, "a", "a:2", { shard: "2" })
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(first).not.toEqual(second)
    expect(labelsOf(map, "a", "a:2", { shard: "3" })).toEqual([])
  })

  it("reads the shared cache from the repository's variable and secrets, and never writes a token", () => {
    const document = inventory([job("a", [step("a:1", "x")])])
    const stepsOf = (workflow: string) =>
      (parseYaml(workflow) as { jobs: { ci: { steps: ReadonlyArray<Record<string, unknown>> } } }).jobs.ci.steps
    const runOf = (workflow: string) =>
      stepsOf(workflow).find((entry) => String(entry["run"]).includes("smthrs ci")) as { env: Record<string, string> }
    // A pull request is given the read token or none; every other event the token that writes. Neither stands in
    // for the other: an unset read token, which is the empty text, never lets a pull request go on to the next.
    const token = "${{ github.event_name == 'pull_request' && secrets.SMITHERS_CACHE_READ_TOKEN || " +
      "github.event_name != 'pull_request' && secrets.SMITHERS_CACHE_TOKEN || '' }}"

    // No URL given: the variable alone names the cache, and a run without it says so before the targets run.
    const plain = content(generate(document), workflowPath)
    expect(runOf(plain).env).toEqual({
      NODE_COMPILE_CACHE: `${stateDirectory}/${compiledCode}`,
      SMTHRS_MACHINES: machinesDirectory,
      SMITHERS_CACHE_URL: "${{ vars.SMITHERS_CACHE_URL }}",
      SMITHERS_CACHE_TOKEN: token
    })
    const notice = stepsOf(plain).findIndex((entry) => entry["name"] === "Shared cache")
    expect(stepsOf(plain)[notice]).toEqual({
      name: "Shared cache",
      if: "${{ vars.SMITHERS_CACHE_URL == '' }}",
      run: `echo ${JSON.stringify(noSharedCache)}`
    })
    expect(stepsOf(plain)[notice + 1]?.["run"]).toContain("smthrs ci")
    const said = spawnSync("bash", ["-c", String(stepsOf(plain)[notice]?.["run"])], { encoding: "utf8" })
    expect(said.stdout).toBe(`${noSharedCache}\n`)
    expect(noSharedCache).toContain("SMITHERS_CACHE_URL variable")
    expect(noSharedCache).toContain("SMITHERS_CACHE_TOKEN secret")

    // A URL given: it is used until the variable is set, so the run always has a cache and says nothing.
    const cached = content(
      Effect.runSync(files(given(document), { cache: "https://cache.example.com/it's" })),
      workflowPath
    )
    expect(runOf(cached).env).toEqual({
      NODE_COMPILE_CACHE: `${stateDirectory}/${compiledCode}`,
      SMTHRS_MACHINES: machinesDirectory,
      SMITHERS_CACHE_URL: "${{ vars.SMITHERS_CACHE_URL || 'https://cache.example.com/it''s' }}",
      SMITHERS_CACHE_TOKEN: token
    })
    expect(stepsOf(cached).map((entry) => entry["name"])).not.toContain("Shared cache")
    for (const workflow of [plain, cached]) expect(workflow).not.toMatch(/TOKEN: (?!\$\{\{ |>-\n +\$\{\{ )/)
  })

  it("checks first that the generated files are what apply writes, with the cache apply was given", () => {
    const document = inventory([job("a", [step("a:1", "x", { inputs: ["src/**"], from: "a:1" })])], {
      toolchains: [{ name: "pnpm", source: "package.json", version: "9.0.0" }]
    })
    const stepsOf = (workflow: string) =>
      (parseYaml(workflow) as { jobs: { ci: { steps: ReadonlyArray<Record<string, unknown>> } } }).jobs.ci.steps
    const check = `npx --yes --package=smithers-ci@${releaseVersion} smithers-ci apply --check`
    // An `apply` that took the jobs that run Docker is checked the same way.
    expect(stepsOf(content(generate(document, { allowDocker: true }), workflowPath))[2]).toEqual({
      name: "Generated files are up to date",
      run: `${check} --allow-docker`
    })
    // After the checkout and the Node smithers-ci runs on, and before the repository's tools, the sandbox and the
    // cache: a pull request that changes the repository's shape fails here, before anything else runs.
    expect(stepsOf(content(generate(document), workflowPath)).slice(0, 4)).toEqual([
      { uses: "actions/checkout@v4" },
      { uses: "actions/setup-node@v4", with: { "node-version": 24 } },
      { name: "Generated files are up to date", run: check },
      { uses: "pnpm/action-setup@v4", with: { version: "9.0.0" } }
    ])
    // A URL apply was given is in the workflow, so the check is given it too, as one word whatever it holds.
    const url = "https://cache.example.com/a b/it's?x=$HOME#c"
    const cached = stepsOf(content(Effect.runSync(files(given(document), { cache: url })), workflowPath))
    const run = String(cached[2]?.["run"])
    expect(run).toBe(`${check} --cache 'https://cache.example.com/a b/it'\\''s?x=$HOME#c'`)
    const words = spawnSync("bash", ["-c", `set -- ${run.slice(check.length)}; printf '%s\\n' "$@"`], {
      encoding: "utf8"
    })
    expect(words.stdout).toBe(`--cache\n${url}\n`)
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

  it("never carries a secret's value, and reports the actions it cannot run", () => {
    const source = targetsOf(fixture("inventory.github-actions-bun.json"))
    expect(source).not.toContain("CODECOV_TOKEN\":")
    expect(source).toContain("codecov/codecov-action@v5 has no command to run")
  })
})

describe("what a step becomes", () => {
  it("observes every step, and gives a step a later step relies on no files of its own", () => {
    const source = targetsOf(inventory([job("a", [step("a:1", "bun install"), step("a:2", "bun test")])]))
    // What the install left is not restored: the build runs it again when the test runs, and only then.
    expect(declaration(source, "a-1")).toContain("S.Shell.Test(")
    expect(declaration(source, "a-1")).toContain(`shell: "bash -e -c 'bun install'"`)
    expect(declaration(source, "a-1")).toContain(
      `observe: { ignore: ["~/.npm/_logs","$TMPDIR/node-compile-cache","~/.config/go/telemetry"] }`
    )
    expect(declaration(source, "a-1")).toContain("data: []")
    // Nothing is written for Smithers CI: no step declares a file of its own to say that it ran.
    expect(source).not.toContain("S.Shell.Build(")
    expect(source).not.toContain("outFiles")
    expect(source).not.toContain(".flows/ci")
    expect(source).toContain(
      "// What a step left for the steps after it is kept, and put back when one of them has to run."
    )
    expect(declaration(source, "a-2")).toContain("S.Shell.Test(")
    expect(declaration(source, "a-2")).toContain(
      `observe: { ignore: ["~/.npm/_logs","$TMPDIR/node-compile-cache","~/.config/go/telemetry"] }`
    )
    expect(declaration(source, "a-2")).toContain(`shell: "bash -e -c 'bun test'"`)
    expect(declaration(source, "a-2")).toMatch(/data: \[repository, step\d+\]/)
  })

  it("always runs a step that keeps files in the build's cache directory, and observes the steps around it", () => {
    // The text a step that restores or saves a cache is run as: it reads where Smithers build keeps its cache.
    const runner = `${runnerEntry}() { __kept='{smthrs:cache-directory}'; bash -e -c "$1"; }`
    const source = targetsOf(inventory([
      job("a", [
        step("a:1", "restore", { runner }),
        step("a:2", "npm ci"),
        step("a:3", "npm test"),
        step("a:4", "save", { runner })
      ])
    ]))
    for (const label of ["a-1", "a-4"]) {
      // What the step finds in the cache directory is in no record, so no result of it is reused.
      expect(declaration(source, label)).toContain("S.Shell.Build(")
      expect(declaration(source, label)).toContain("cache: false")
      expect(declaration(source, label)).not.toContain("observe")
      expect(declaration(source, label)).not.toContain("outFiles")
      expect(declaration(source, label)).toContain(`sandbox: "none"`)
    }
    expect(declaration(source, "a-1")).toContain("data: []")
    expect(declaration(source, "a-4")).toMatch(/data: \[repository, step\d+\]/)
    for (const label of ["a-2", "a-3"]) {
      expect(declaration(source, label)).toContain("S.Shell.Test(")
      expect(declaration(source, label)).toContain(
        `observe: { ignore: ["~/.npm/_logs","$TMPDIR/node-compile-cache","~/.config/go/telemetry"] }`
      )
    }
    // Alone in its job and naming its inputs, it still always runs: its inputs do not name the cache directory.
    const alone = targetsOf(inventory([job("b", [step("b:1", "restore", { runner, inputs: ["lock.json"] })])]))
    expect(declaration(alone, "b-1")).toContain(`data: [S.glob("//lock.json")]`)
    expect(declaration(alone, "b-1")).toContain("S.Shell.Build(")
    expect(declaration(alone, "b-1")).toContain("cache: false")
    expect(declaration(alone, "b-1")).toContain(`sandbox: "none"`)
  })

  it("treats a needed job as setup only when the jobs share a working tree", () => {
    const shared = targetsOf(inventory([
      job("build", [step("build:1", "make")], { source: "justfile", triggers: [] }),
      job("test", [step("test:1", "make test")], { source: "justfile", triggers: [], needs: ["build"] })
    ]))
    expect(declaration(shared, "build-1")).toContain("data: []")
    const separate = targetsOf(inventory([
      job("build", [step("build:1", "make")]),
      job("test", [step("test:1", "make test")], { needs: ["build"] })
    ]))
    expect(declaration(separate, "build-1")).toContain("data: [repository]")
    expect(declaration(separate, "test-1")).toMatch(/data: \[repository, step0\]/)
  })

  it("runs the jobs of one working tree one after another, in the order the CI lists them", () => {
    const recipe = (name: string, extra: Partial<Job> = {}): Job =>
      job(`justfile:${name}`, [step(`${name}:1`, `just ${name}`)], {
        source: "justfile",
        file: "justfile",
        triggers: [],
        ...extra
      })
    // `ci: build test`: neither recipe needs the other, and `just ci` still runs `build` first.
    const listed = targetsOf(inventory([recipe("build"), recipe("test")]))
    expect(declaration(listed, "build-1")).toContain("S.Shell.Test(")
    expect(declaration(listed, "build-1")).toContain("data: []")
    expect(declaration(listed, "test-1")).toContain("S.Shell.Test(")
    expect(declaration(listed, "test-1")).toContain("data: [repository, step0]")
    // `ci: test build` runs them the other way round.
    const reversed = targetsOf(inventory([recipe("test"), recipe("build")]))
    expect(declaration(reversed, "test-1")).toContain("data: []")
    expect(declaration(reversed, "build-1")).toContain("data: [repository, step0]")
    // What a recipe needs runs before it, and each recipe waits for the one before it only once.
    const needing = targetsOf(inventory([
      recipe("lint"),
      recipe("test", { needs: ["justfile:build"] }),
      recipe("build")
    ]))
    expect(declaration(needing, "lint-1")).toContain("data: []")
    expect(declaration(needing, "build-1")).toContain("data: [step0]")
    expect(declaration(needing, "test-1")).toContain("data: [repository, step1]")
    // A job with a checkout of its own waits only for what it names, and another file is another tree.
    const apart = targetsOf(inventory([
      job("a", [step("a:1", "x")]),
      job("b", [step("b:1", "y")]),
      recipe("make", { source: "makefile", file: "Makefile" }),
      recipe("just")
    ]))
    for (const label of ["a-1", "b-1", "make-1", "just-1"]) {
      expect(declaration(apart, label), label).toContain("data: [repository]")
    }
  })

  it("runs every step under the shell the baseline runs it under, whatever its source", () => {
    const source = targetsOf(inventory([
      job("a", [step("a:1", "echo 'hi' && false\necho next"), step("a:2", "source scripts/check.sh")]),
      job("b", [step("b:1", "false\ntrue")], { source: "makefile", file: "Makefile", name: "test" }),
      job("c", [step("c:1", "#!/usr/bin/env bash\n[[ -f x ]]")], { source: "justfile", file: "justfile", name: "test" })
    ]))
    expect(declaration(source, "a-1")).toContain(
      JSON.stringify(`bash -e -c 'echo '\\''hi'\\'' && false\necho next'`)
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
    // `Inventory.ci` leaves out a job whose step receives a secret, so a command that names one is not generated.
    expect(declaration(source, "a-2")).toBe("")
    expect(source).toContain("// a:2: not generated, it uses a value only GitHub Actions can provide.")
  })

  it("passes the variables every target is told to pass, beside its own, unless the step sets one", () => {
    const document = inventory([job("a", [
      step("a:1", "echo $RUNNER_OS"),
      step("a:2", "git push", { env: { GIT_TERMINAL_PROMPT: "1" } }),
      step("a:3", "true")
    ])])
    const passed = { inheritEnv: ["GIT_TERMINAL_PROMPT", "GIT_CONFIG_COUNT", "RUNNER_OS"] }
    const source = content(Effect.runSync(files(given(document), passed)), packagePath)
    expect(declaration(source, "a-1")).toContain(`inheritEnv: ["GIT_CONFIG_COUNT","GIT_TERMINAL_PROMPT","RUNNER_OS"]`)
    // Smithers build refuses a variable a target both sets and passes on, and the step's value is the one it means.
    expect(declaration(source, "a-2")).toContain(`env: {"GIT_TERMINAL_PROMPT":"1"}`)
    expect(declaration(source, "a-2")).toContain(`inheritEnv: ["GIT_CONFIG_COUNT","RUNNER_OS"]`)
    expect(declaration(source, "a-3")).toContain(`inheritEnv: ["GIT_CONFIG_COUNT","GIT_TERMINAL_PROMPT","RUNNER_OS"]`)
    // Without the option a target passes on only what its step names.
    expect(declaration(targetsOf(document), "a-3")).not.toContain("inheritEnv")
  })

  it("runs a step with runner text as that text, and leaves the runner's variables to it", () => {
    const runner = `${runnerEntry}() { export RUNNER_TEMP=/tmp/\${{ matrix.os }}; bash -e -c "$1"; }`
    const written = step("a:1", "echo ${{ steps.pick.outputs.lane }} $RUNNER_TEMP $GITHUB_SHA ${{ matrix.os }}", {
      runner
    })
    const source = targetsOf(inventory([job("a", [written], { matrix: [{ os: "linux" }], runsOn: "ubuntu-latest" })]))
    const target = declaration(source, "a-1--linux")
    // The target runs what the baseline runs: the runner text, then its function with the command as one word.
    // Only matrix values are written into either: the runner text fills in what else `${{ }}` stands for.
    const text = script({ ...written, runner: runner.replace("${{ matrix.os }}", "linux") }).replace(
      "${{ matrix.os }}",
      "linux"
    )
    expect(text).toContain("echo ${{ steps.pick.outputs.lane }} $RUNNER_TEMP $GITHUB_SHA linux")
    expect(target).toContain(JSON.stringify(`${shell.join(" ")} '${text.replaceAll("'", `'\\''`)}'`))
    // The runner text gives every runner variable itself, but where the event file is and where the machine has
    // a runner's software.
    expect(target).toContain(`inheritEnv: ${JSON.stringify(passedOn())}`)
    expect(source).not.toContain("not generated")
  })

  it("lets a step with runner text keep a software variable it sets itself", () => {
    const runner = `${runnerEntry}() { bash -e -c "$1"; }`
    const own = step("a:1", "java -version", { runner, env: { JAVA_HOME: "/own" } })
    const target = declaration(targetsOf(inventory([job("a", [own])])), "a-1")
    expect(target).toContain(`env: {"JAVA_HOME":"/own"}`)
    expect(target).toContain(JSON.stringify(runGiven.filter((name) => name !== "JAVA_HOME")))
    expect(target).not.toContain(JSON.stringify(runGiven))
  })

  // A runner gives every step the commit, the run's id, number and attempt, and the event file. A target passes
  // the first four on from the run with their values out of its key, so its result is reused at another commit
  // unless its run used one. The event file's place is the same at every run and is part of the key.
  it("passes on what a run gives every step, with what is another at every run out of the key", () => {
    const runner = `${runnerEntry}() { bash -e -c "$1"; }`
    const source = targetsOf(inventory([job("a", [
      step("a:1", "npm ci", { runner }),
      step("a:2", "npm test", { runner }),
      step("a:3", "npm run lint", { runner, env: { GITHUB_SHA: "pinned", [eventsVariable]: "/elsewhere" } }),
      step("a:4", "true"),
      step("a:5", "npm run typecheck", { runner, env: { GITHUB_RUN_ID: "pinned" } })
    ])]))
    const run = JSON.stringify(runGiven)
    expect(runVariables).toEqual([
      "GITHUB_RUN_ATTEMPT",
      "GITHUB_RUN_ID",
      "GITHUB_RUN_NUMBER",
      "GITHUB_SHA",
      "GITHUB_WORKFLOW_SHA"
    ])
    const ignore = JSON.stringify(["~/.npm/_logs", "$TMPDIR/node-compile-cache", "~/.config/go/telemetry"])
    // The git the runner text asks which commit is checked out is quiet: what it reads is no step's.
    const quiet = JSON.stringify([commitQuestion])
    // A workflow file the step reads is data: a runner variable's name in it does not run the step again.
    const data = JSON.stringify([".github/workflows"])
    // A step the steps after it wait for is observed as the last one is: what a run gives is passed on with its
    // value out of the key.
    expect(declaration(source, "a-1")).toContain(`inheritEnv: ${JSON.stringify(passedOn())}`)
    expect(declaration(source, "a-1")).toContain(
      `observe: { ignore: ${ignore}, env: ${run}, quiet: ${quiet}, readAsData: ${data}, byValue: ["GITHUB_RUN_ID"] }`
    )
    // Smithers build refuses a variable a target both sets and passes on, and the step's value is the one it means.
    expect(declaration(source, "a-3")).toContain(
      `inheritEnv: ${JSON.stringify(passedOn().filter((name) => name !== eventsVariable))}`
    )
    expect(declaration(source, "a-3")).toContain(
      `observe: { ignore: ${ignore}, env: ${
        JSON.stringify(runGiven.filter((name) => name !== "GITHUB_SHA"))
      }, quiet: ${quiet}, readAsData: ${data}, byValue: ["GITHUB_RUN_ID"] }`
    )
    // A step that pins GITHUB_RUN_ID itself omits byValue from observe.
    expect(declaration(source, "a-5")).toContain(
      `observe: { ignore: ${ignore}, env: ${
        JSON.stringify(runGiven.filter((name) => name !== "GITHUB_RUN_ID"))
      }, quiet: ${quiet}, readAsData: ${data} }`
    )
    // A step without runner text is given no runner variable it does not name.
    expect(declaration(source, "a-4")).toContain(`observe: { ignore: ${ignore} }`)
    expect(declaration(source, "a-4")).not.toContain("inheritEnv")
    const last = targetsOf(inventory([job("a", [step("a:1", "npm test", { runner })])]))
    expect(declaration(last, "a-1")).toContain(`inheritEnv: ${JSON.stringify(passedOn())}`)
    expect(declaration(last, "a-1")).toContain(
      `observe: { ignore: ${ignore}, env: ${run}, quiet: ${quiet}, readAsData: ${data}, byValue: ["GITHUB_RUN_ID"] }`
    )
  })

  it("holds a step with runner text to its inputs only as its job's first step, and never when it reads the commit", () => {
    const runner = `${runnerEntry}() { bash -e -c "$1"; }`
    const reads = `${runnerEntry}() {\n${commitNote}\nbash -e -c "$1"\n}`
    const install = { inputs: ["bun.lock"], outputs: ["node_modules/**"] }
    const tests = { inputs: ["packages/a/**"] }
    const source = targetsOf(inventory([
      job("first", [step("first:1", "bun test", { runner, ...tests })]),
      job("commit", [step("commit:1", "bun test", { runner: reads, ...tests })]),
      job("later", [
        step("later:1", "bun install", { runner, ...install }),
        step("later:2", "bun test", { runner, ...tests })
      ]),
      job("plain", [step("plain:1", "bun install", install), step("plain:2", "bun test", tests)])
    ]))
    const held = `sandbox: { network: true }`
    expect(declaration(source, "first-1")).toContain(held)
    // A held step is given what a run gives every step. Smithers build keys it on the values only when its text
    // or one of its inputs names one, or names where the event file is.
    expect(declaration(source, "first-1")).toContain(
      `given: { env: ${JSON.stringify(runGiven)}, names: ["GITHUB_EVENT_PATH"] }`
    )
    expect(declaration(source, "first-1")).toContain(`inheritEnv: ${JSON.stringify(passedOn())}`)
    expect(declaration(source, "first-1")).not.toContain("observe")
    // Its verdict is one commit's, so it declares the whole repository and is never reused for another.
    expect(declaration(source, "commit-1")).toContain(`sandbox: "none"`)
    expect(declaration(source, "commit-1")).toContain("data: [repository]")
    // It reads what the step before it left for the job, which is in no input.
    expect(declaration(source, "later-2")).toContain(`sandbox: "none"`)
    for (const label of ["commit-1", "later-2"]) {
      expect(declaration(source, label)).toContain(
        `env: ${JSON.stringify(runGiven)}, quiet: ${
          JSON.stringify([commitQuestion])
        }, readAsData: [".github/workflows"], byValue: ["GITHUB_RUN_ID"] }`
      )
      expect(declaration(source, label)).not.toContain("given:")
    }
    // No runner starts it, so no run gives it anything.
    expect(declaration(source, "plain-2")).toContain(held)
    expect(declaration(source, "plain-2")).not.toContain("given:")
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
    expect(content(generate(ci(document)), workflowPath)).toContain(
      "on:\n  - pull_request\n# prettier-ignore\npermissions:"
    )
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

describe("a step two jobs both run", () => {
  const mapOf = (document: InventoryDocument): TargetMap =>
    Schema.decodeUnknownSync(Schema.fromJsonString(TargetMap))(content(generate(document), targetMapPath))
  const labels = (source: string): ReadonlyArray<string> =>
    [...source.matchAll(/^ {4}"([^"]+)": step/gm)].map((match) => match[1] as string)
  const lint = job("lint", [step("lint:1", "npm ci"), step("lint:2", "npm run lint")])
  const test = job("test", [step("test:1", "npm ci"), step("test:2", "npm test")])
  // A job whose only step names what it reads is held to those files: it writes nothing another job reads.
  const held = (id: string, extra: Partial<Step> = {}, more: Partial<Job> = {}): Job =>
    job(id, [step(`${id}:1`, "node check.js", { inputs: ["src/**"], ...extra })], more)

  it("runs once in each job, on that job's machine, as each job of a workflow starts on a runner of its own", () => {
    // The second ship review's blocker 2: one install for both jobs meant one tree for both jobs.
    const document = inventory([test, lint])
    const source = targetsOf(document)
    expect(labels(source)).toEqual(["lint-1", "lint-2", "test-1", "test-2"])
    expect(source).not.toContain("the same step, run once")
    for (const name of ["lint", "test"]) {
      // The install is recorded like any other step, and declares no files of its own.
      expect(declaration(source, `${name}-1`)).toContain("S.Shell.Test(")
      expect(declaration(source, `${name}-1`)).toContain("data: []")
      expect(declaration(source, `${name}-1`)).toContain(`machine: "${name}"`)
      expect(declaration(source, `${name}-2`)).toContain(`machine: "${name}"`)
    }
    expect(declaration(source, "lint-2")).toMatch(/data: \[repository, step0\]/)
    expect(declaration(source, "test-2")).toMatch(/data: \[repository, step2\]/)
    const map = mapOf(document)
    expect(map.targets.map((entry) => entry.step)).toEqual(["lint:1", "lint:2", "test:1", "test:2"])
    expect(labelsOf(map, "test", "test:1", {})).toEqual(["//:test-1"])
    expect(labelsOf(map, "lint", "lint:1", {})).toEqual(["//:lint-1"])
    // The target map names each target's machine, so a replay runs the job's baseline at the machine's paths.
    expect(map.targets.map((entry) => entry.machine)).toEqual(["lint", "lint", "test", "test"])
  })

  it("gives each matrix variant a machine of its own, named for the variant", () => {
    const source = targetsOf(inventory([job("a", [step("a:1", "npm ci"), step("a:2", "npm test")], {
      matrix: [{ node: "18" }, { node: "20" }]
    })]))
    expect(declaration(source, "a-1--18")).toContain(`machine: "a [[\\"node\\",\\"18\\"]]"`)
    expect(declaration(source, "a-2--18")).toContain(`machine: "a [[\\"node\\",\\"18\\"]]"`)
    expect(declaration(source, "a-1--20")).toContain(`machine: "a [[\\"node\\",\\"20\\"]]"`)
  })

  it("names no machine for the recipes of one working tree, which share it on purpose", () => {
    const recipe = (name: string): Job =>
      job(`justfile:${name}`, [step(`${name}:1`, "make")], { source: "justfile", file: "justfile", triggers: [] })
    expect(targetsOf(inventory([recipe("build"), recipe("test")]))).not.toContain("machine: \"")
    expect(mapOf(inventory([recipe("build"), recipe("test")])).targets.map((entry) => entry.machine)).toEqual([
      undefined,
      undefined
    ])
  })

  it("runs once for two jobs held to the files they name, and names no machine for them", () => {
    const document = inventory([held("test"), held("lint")])
    const source = targetsOf(document)
    expect(labels(source)).toEqual(["lint-1"])
    expect(source).toContain("// lint / lint:1\n// test / test:1: the same step, run once\nconst step0 =")
    expect(declaration(source, "lint-1")).toContain("sandbox: { network: true }")
    expect(source).not.toContain("machine: \"")
    // Each step keeps its own entry in the target map, and the two name one target.
    const map = mapOf(document)
    expect(map.targets.map((entry) => entry.step)).toEqual(["lint:1", "test:1"])
    expect(labelsOf(map, "test", "test:1", {})).toEqual(["//:lint-1"])
    expect(labelsOf(map, "lint", "lint:1", {})).toEqual(["//:lint-1"])
  })

  it("keeps apart held steps that differ in directory, environment, system or what ran before them", () => {
    const apart = (other: Job): ReadonlyArray<string> => labels(targetsOf(inventory([held("lint"), other])))
    expect(apart(held("test"))).toHaveLength(1)
    expect(apart(held("test", { cwd: "web" }))).toHaveLength(2)
    expect(apart(held("test", { env: { CI: "1" } }))).toHaveLength(2)
    expect(apart(held("test", {}, { runsOn: "macos-latest" }))).toHaveLength(2)
    expect(apart(held("test", {}, { needs: ["lint"] }))).toHaveLength(2)
  })

  it("gives a job a machine when one of its steps is not held to the files it names", () => {
    const all = (steps: ReadonlyArray<Step>): string => targetsOf(inventory([job("a", steps)]))
    const named = step("a:1", "make dist", { inputs: ["src/**"], outputs: ["dist/**"], from: "a:1" })
    // Every step names what it reads, and every step before the last what it writes: no machine.
    expect(all([named, step("a:2", "make test", { inputs: ["dist/**"], from: "a:2" })])).not.toContain("machine: \"")
    // A step that reads everything, one that names no inputs, and one after a step that does not say what it writes.
    for (
      const steps of [
        [step("a:1", "make", { inputs: ["**"] })],
        [named, step("a:2", "make test")],
        [step("a:1", "make dist", { inputs: ["src/**"], from: "a:1" }), step("a:2", "make test", { inputs: ["x"] })]
      ]
    ) {
      const source = all(steps)
      expect(source.match(/machine: "a"/g)).toHaveLength(steps.length)
      expect(source).not.toContain("sandbox: { network: true }")
    }
    // A step with runner text is held to its inputs only as its job's first step, and never when it reads the commit.
    const runner = (note: string): string => `${runnerEntry}() {\n${note}bash -e -c "$1"\n}`
    const first = step("a:1", "make", { inputs: ["src/**"], runner: runner("") })
    expect(all([first])).not.toContain("machine: \"")
    expect(all([first, step("a:2", "make test", { inputs: ["src/**"], runner: runner("") })])).toContain(
      `machine: "a"`
    )
    expect(all([step("a:1", "make", { inputs: ["src/**"], runner: runner(`${commitNote}\n`) })])).toContain(
      `machine: "a"`
    )
  })

  it("keeps apart the recipes of one working tree, and steps split from one step", () => {
    const recipe = (name: string): Job =>
      job(`justfile:${name}`, [step(`${name}:1`, "make")], { source: "justfile", file: "justfile", triggers: [] })
    // The second `make` runs in the tree the first one left: it is not the same work.
    expect(labels(targetsOf(inventory([recipe("build"), recipe("test")])))).toHaveLength(2)
    const part = (id: string): Step =>
      step(id, "pnpm --filter=ui run test", { inputs: ["packages/ui/**"], from: "t:1" })
    expect(labels(targetsOf(inventory([job("a", [part("a:1:ui")]), job("b", [part("b:1:ui")])])))).toHaveLength(2)
  })
})

describe("the /tmp of a job in the workflow", () => {
  const one = job("lint", [step("lint:1", "npm ci"), step("lint:2", "npm run lint")])
  const two = job("test", [step("test:1", "npm ci"), step("test:2", "npm test")])

  it("is the job's own on a Linux runner, and two jobs are never let share one", () => {
    const workflow = content(generate(inventory([one, two])), workflowPath)
    // Each job's targets run with a mount of their own, by bubblewrap, which an Ubuntu runner lacks.
    expect(commentsOf(workflow)).toContain(
      "Each job has a /tmp of its own, as it has a runner of its own in the original CI."
    )
    expect(workflow).toContain(
      "original CI.\n      - name: Give each job its own /tmp\n        if: runner.os == 'Linux'" +
        " && runner.environment == 'github-hosted'\n"
    )
    expect(workflow).toContain("apt-get install -y -qq --no-install-recommends bubblewrap")
    expect(workflow).toContain("sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0")
    expect(workflow.indexOf("bubblewrap\n")).toBeLessThan(workflow.indexOf("smthrs ci"))
    expect(workflow).toContain("          SMTHRS_MACHINE_OWN_TMP: required\n")
    // The jobs' checkouts are under no directory named .cache, where Biome skips a project's nested biome.json.
    expect(workflow).toContain("          SMTHRS_MACHINES: ${{ runner.temp }}/smthrs-machines\n")
    // One job has nobody to share with, and still gets its own `/tmp`.
    const single = content(generate(inventory([one])), workflowPath)
    expect(single).toContain("      - name: Give each job its own /tmp\n")
    expect(single).not.toContain("SMTHRS_MACHINE_OWN_TMP")
    // The recipes of a Justfile run in one working tree, as `just` runs them: no machine, nothing installed for one.
    const tree = content(
      generate(inventory([{ ...one, source: "justfile", file: "Justfile" }])),
      workflowPath
    )
    expect(tree).not.toContain("Give each job its own /tmp")
    expect(tree).not.toContain("SMTHRS_MACHINE_OWN_TMP")
    expect(tree).not.toContain("SMTHRS_MACHINES")
  })

  it("is the runner's own on macOS, where each job is a runner job of its own", () => {
    // A macOS runner cannot give a job a mount of its own, so two jobs there never meet on one runner.
    const mac = (id: string, command: string, extra: Partial<Job> = {}): Job =>
      job(id, [step(`${id}:1`, "npm ci"), step(`${id}:2`, command)], { runsOn: "macos-latest", ...extra })
    const linux = (id: string, command: string): Job =>
      job(id, [step(`${id}:1`, "npm ci"), step(`${id}:2`, command)], { runsOn: "ubuntu-latest" })
    const generated = generate(inventory([
      mac("lint", "npm run lint"),
      mac("test", "npm test", { needs: ["lint"] }),
      linux("linux-lint", "npm run lint"),
      linux("linux-test", "npm test")
    ]))
    const include = (parseYaml(content(generated, workflowPath)) as {
      readonly jobs: { readonly ci: { readonly strategy: { readonly matrix: { readonly include: unknown } } } }
    }).jobs.ci.strategy.matrix.include
    expect(include).toEqual([
      { os: "macos-latest", leg: 1, tools: "job lint" },
      { os: "macos-latest", leg: 2, tools: "job test" },
      { os: "ubuntu-latest", leg: 3 }
    ])
    // Each macOS job runs its own targets and no other job's; the Linux jobs share one runner, each with a mount.
    const legs = content(generated, legsPath).split("\n").slice(1, -1)
    expect(legs.filter((line) => line.startsWith("1 "))).toEqual(["1 //:lint-1", "1 //:lint-2"])
    expect(legs.filter((line) => line.startsWith("2 "))).toEqual(["2 //:test-1", "2 //:test-2"])
    expect(legs.filter((line) => line.startsWith("3 ")).map((line) => line.slice(2)).sort()).toEqual([
      "//:linux-lint-1",
      "//:linux-lint-2",
      "//:linux-test-1",
      "//:linux-test-2"
    ])
    // A job that needs another on macOS does not pull that job's targets onto its own runner, and the notes say so.
    const source = content(generated, packagePath)
    expect(declaration(source, "test-1")).toContain("data: []")
    expect(content(generated, notesPath)).toContain(
      "test: runs with job test, so it does not wait for lint, which runs with job lint."
    )
    // A matrix variant is a job of its own.
    const variants = generate(inventory([
      mac("unit", "npm test", { matrix: [{ node: "18" }, { node: "20" }] })
    ]))
    expect(content(variants, workflowPath)).toContain(`tools: job unit (node 18)\n`)
    expect(content(variants, workflowPath)).toContain(`tools: job unit (node 20)\n`)
  })

  it("is installed once where a target is also held to its inputs", () => {
    const held = job("held", [step("held:1", "x", { inputs: ["src/**"], from: "held:1" })])
    const workflow = content(generate(inventory([one, two, held])), workflowPath)
    expect(workflow).toContain("      - name: Install the read sandbox\n")
    expect(workflow).not.toContain("Give each job its own /tmp")
    expect(workflow.match(/--no-install-recommends bubblewrap/g)).toHaveLength(1)
    expect(workflow).toContain("          SMTHRS_MACHINE_OWN_TMP: ")
  })
})

describe("a tool's own cache", () => {
  const split = (name: string): Step =>
    step(`z:1:${name}`, `zig build ${name}`, { from: "z:1", atOnce: true, shares: [".zig-cache", "~/.cache/zig"] })
  const whole = step("z:1", "zig build test", { env: { MODE: "../release" } })

  it("is left where the tool puts it: no target is told where to keep one", () => {
    // A GitHub job runs on a machine of its own, and a recipe of a Justfile in the repository itself. Either way the
    // step's variables are the step's own, and nothing in them names Smithers build's cache directory.
    const machine = targetsOf(inventory([job("z", [whole])]))
    expect(declaration(machine, "z-1")).toContain(`machine: "z"`)
    expect(declaration(machine, "z-1")).toContain(`env: {"MODE":"../release"}`)
    const tree = targetsOf(inventory([job("z", [whole], { source: "justfile", file: "Justfile" })]))
    expect(declaration(tree, "z-1")).not.toContain("machine")
    expect(declaration(tree, "z-1")).toContain(`env: {"MODE":"../release"}`)
    for (const source of [machine, tree]) {
      expect(source).not.toContain("ZIG_")
      expect(source).not.toContain("GOCACHE")
      expect(source).not.toContain("{smthrs:cache-directory}/tools")
    }
    // The workspace leaves `go` its own cache too.
    expect(machine).toContain(`cache: S.Cache({ directory: ".flows", outside: true, goBuild: false })`)
  })

  it("is left out of what a step is seen to read where the steps beside it write it at the same time", () => {
    const source = targetsOf(
      inventory([job("z", [split("test-a"), split("test-b")], { source: "justfile", file: "Justfile" })])
    )
    for (const label of ["z-1-test-a", "z-1-test-b"]) {
      expect(declaration(source, label)).toContain(
        `observe: { ignore: ["~/.npm/_logs","$TMPDIR/node-compile-cache","~/.config/go/telemetry",".zig-cache","~/.cache/zig"] }`
      )
    }
    // A step that runs alone reads only what it made there itself, which is no input of it: nothing more is left out.
    expect(declaration(targetsOf(inventory([job("z", [whole])])), "z-1")).toContain(
      `observe: { ignore: ["~/.npm/_logs","$TMPDIR/node-compile-cache","~/.config/go/telemetry"]`
    )
  })
})

describe("how many targets run at once", () => {
  const mapOf = (document: InventoryDocument): TargetMap =>
    Schema.decodeUnknownSync(Schema.fromJsonString(TargetMap))(content(generate(document), targetMapPath))
  const workflowOf = (document: InventoryDocument): string => content(generate(document), workflowPath)
  const part = (id: string, name: string): Step =>
    step(id, `pnpm --filter=${name} run test`, { inputs: [`packages/${name}/**`], from: "a:1" })

  it("leaves the number to Smithers build when no two targets can write the same files", () => {
    // One chain: each target runs after the one before it.
    const chain = inventory([job("a", [step("a:1", "npm ci"), step("a:2", "npm test")])])
    expect(mapOf(chain).maxJobs).toBeUndefined()
    expect(smthrsRun(workflowOf(chain))).toMatch(/smthrs ci '\/\/\.\.\.' --cache-dir /)
    expect(workflowOf(chain)).not.toContain("one at a time")
    // Targets held to their inputs cannot write the working tree, so they run beside each other.
    const held = inventory([job("a", [part("a:1:ui", "ui"), part("a:1:web", "web")])])
    expect(mapOf(held).maxJobs).toBeUndefined()
    // Two jobs for two systems never run on one machine.
    const systems = inventory([
      job("linux", [step("linux:1", "make")], { runsOn: "ubuntu-latest" }),
      job("mac", [step("mac:1", "make")], { runsOn: "macos-latest" })
    ])
    expect(mapOf(systems).maxJobs).toBeUndefined()
  })

  it("runs one target at a time when two of them can write the same files", () => {
    const two = inventory([
      job("lint", [step("lint:1", "npm ci"), step("lint:2", "npm run lint")]),
      job("test", [step("test:1", "npm ci"), step("test:2", "npm test")])
    ])
    expect(mapOf(two).maxJobs).toBe(1)
    expect(workflowOf(two)).toContain(
      "      # Targets that can write the same files run one at a time.\n      - run: >-\n"
    )
    expect(smthrsRun(workflowOf(two))).toBe(
      `npx --yes --package=@smthrs/cli@${releaseVersion} smthrs ci '//...' --jobs 1 --cache-dir "${stateDirectory}"`
    )
    // A target that can write the tree beside one held to its inputs: the held one could read a half-written file.
    const beside = inventory([job("a", [part("a:1:ui", "ui")]), job("b", [step("b:1", "make")])])
    expect(mapOf(beside).maxJobs).toBe(1)
    // A job for every system runs beside a job for one of them.
    const anywhere = inventory([
      job("any", [step("any:1", "make")]),
      job("linux", [step("linux:1", "make test")], { runsOn: "ubuntu-latest" })
    ])
    expect(mapOf(anywhere).maxJobs).toBe(1)
    const same = inventory([
      job("one", [step("one:1", "make")], { runsOn: "ubuntu-latest" }),
      job("two", [step("two:1", "make test")], { runsOn: "ubuntu-22.04" })
    ])
    expect(mapOf(same).maxJobs).toBe(1)
  })

  it("runs at once the steps split from a command that ran them at once", () => {
    const root = (name: string, extra: Partial<Step> = {}): Step =>
      step(`t:2:${name}`, `zig build ${name}`, { from: "t:2", atOnce: true, ...extra })
    const tidy = step("t:1", "./tidy.sh")
    // `zig build test` ran its named steps at the same time in one tree: the steps split from it still do.
    const zig = inventory([job("t", [tidy, root("test-a"), root("test-b"), root("test-c")])])
    expect(mapOf(zig).targets).toHaveLength(4)
    expect(mapOf(zig).maxJobs).toBeUndefined()
    expect(smthrsRun(workflowOf(zig))).toMatch(/smthrs ci '\/\/\.\.\.' --cache-dir /)
    expect(workflowOf(zig)).not.toContain("one at a time")
    // Split steps that do not say so can write the same files, and so can one that says so beside one that does not.
    const silent = { atOnce: false }
    expect(mapOf(inventory([job("t", [tidy, root("test-a", silent), root("test-b", silent)])])).maxJobs).toBe(1)
    expect(mapOf(inventory([job("t", [tidy, root("test-a"), root("test-b", silent)])])).maxJobs).toBe(1)
    // A step that was not split from another has no such sibling, whatever it says.
    const whole = (id: string, command: string): Step => step(id, command, { atOnce: true })
    expect(
      mapOf(inventory([job("t", [whole("t:2", "zig build test")]), job("u", [whole("u:2", "zig build check")])]))
        .maxJobs
    )
      .toBe(1)
    // Another job's step never ran beside them, and neither did the same steps of another job or variant.
    expect(mapOf(inventory([job("t", [root("test-a"), root("test-b")]), job("u", [step("u:1", "make")])])).maxJobs)
      .toBe(1)
    expect(mapOf(inventory([job("t", [root("test-a")]), job("u", [root("test-b")])])).maxJobs).toBe(1)
    const variants = job("t", [root("test-a"), root("test-b")], {
      matrix: [{ mode: "Debug" }, { mode: "ReleaseSafe" }]
    })
    expect(mapOf(inventory([variants])).maxJobs).toBe(1)
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

  it("observes a step nobody declared inputs for, and no other", () => {
    const source = targetsOf(inventory([job("a", [step("a:1", "npm ci"), step("a:2", "npm test")]), job("b", parts)]))
    // What the step reads is recorded when it runs; npm's own log directory is left out of the record.
    expect(declaration(source, "a-2")).toContain(
      `  sandbox: "none",\n  observe: { ignore: ["~/.npm/_logs","$TMPDIR/node-compile-cache","~/.config/go/telemetry"] },\n`
    )
    // So is what a step a later step relies on reads; a step held to its inputs is already known.
    expect(declaration(source, "a-1")).toContain(
      `  sandbox: "none",\n  observe: { ignore: ["~/.npm/_logs","$TMPDIR/node-compile-cache","~/.config/go/telemetry"] },\n`
    )
    expect(declaration(source, "a-2-ui")).not.toContain("observe")
    expect(declaration(source, "a-2-web")).not.toContain("observe")
  })

  it("keeps the whole repository for a step that follows another in its working tree", () => {
    // The install wrote files the package steps read, and nothing says which files it read to write them.
    const source = targetsOf(split())
    // The setup step declares no files.
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
    // A later step relies on them, so they run unconfined, are observed, and declare no files.
    expect(declaration(followed, "a-2-ui")).toContain("S.Shell.Test(")
    expect(declaration(followed, "a-2-ui")).toMatch(/data: \[step0\]/)
    expect(declaration(followed, "a-2-ui")).toContain(`sandbox: "none"`)
    expect(declaration(followed, "a-2-web")).toContain(
      `observe: { ignore: ["~/.npm/_logs","$TMPDIR/node-compile-cache","~/.config/go/telemetry"] }`
    )
  })

  it("keeps the order of steps split from a command that ran its parts in order", () => {
    // `npm run check` was `npm run lint && npm run types`: the types never ran after a lint that failed.
    const links = [
      step("a:2:lint", "npm run lint", { from: "a:2", inOrder: true }),
      step("a:2:types", "npm run types", { from: "a:2", inOrder: true })
    ]
    const source = targetsOf(inventory([job("a", [step("a:1", "npm ci"), ...links, step("a:3", "npm test")])]))
    // Each link waits for the one before it, and the step after them for the last.
    expect(declaration(source, "a-2-lint")).toMatch(/data: \[step0\]/)
    expect(declaration(source, "a-2-types")).toMatch(/data: \[step1\]/)
    expect(declaration(source, "a-2-types")).not.toContain("step0")
    expect(declaration(source, "a-3")).toMatch(/data: \[repository, step2\]/)
    // Both links answer for the step they were split from.
    const map = Schema.decodeUnknownSync(Schema.fromJsonString(TargetMap))(
      content(generate(inventory([job("a", [step("a:1", "npm ci"), ...links])])), targetMapPath)
    )
    expect(labelsOf(map, "a", "a:2", {})).toEqual(["//:a-2-lint", "//:a-2-types"])
    // Each says which part of the step it is, so a report can name the script that failed.
    expect(map.targets).toEqual([
      { label: "//:a-1", job: "a", step: "a:1", variant: {}, machine: "a" },
      { label: "//:a-2-lint", job: "a", step: "a:2", variant: {}, part: "lint", machine: "a" },
      { label: "//:a-2-types", job: "a", step: "a:2", variant: {}, part: "types", machine: "a" }
    ])
    // A step whose id says nothing after the step it came from is no part of it.
    const unnamed = Schema.decodeUnknownSync(Schema.fromJsonString(TargetMap))(
      content(
        generate(inventory([job("a", [
          step("a:1", "true", { from: "a:1" }),
          step("a:1:", "true", { from: "a:1" }),
          step("b", "true", { from: "a:1" })
        ])])),
        targetMapPath
      )
    )
    expect(unnamed.targets.map((entry) => entry.part)).toEqual([undefined, undefined, undefined])
    // A dependency orders every pair, so the links never make the run one at a time on their own account.
    const alone = generate(inventory([job("a", links)]))
    expect(content(alone, workflowPath)).not.toContain("--jobs 1")
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

  it("declares the whole repository for every target when the inputs do not fit in the one file", () => {
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

describe("a step that says what it writes", () => {
  const build = (extra: Partial<Step>): Step =>
    step("a:1", "make dist", { inputs: ["config/**", "Makefile"], from: "a:1", ...extra })
  const test = step("a:2", "make test", { inputs: ["packages/a/**"], from: "a:2" })

  it("declares a setup step's inputs and outputs, and keeps the step after it narrowed", () => {
    const source = targetsOf(inventory([job("a", [
      build({ outputs: ["packages/a/dist/**", "./build/info.txt", "packages/b/dist/**"] }),
      test
    ])]))
    // The setup target still always runs, in the open. Its key now holds what it reads.
    expect(declaration(source, "a-1")).toContain("S.Shell.Build(")
    expect(declaration(source, "a-1")).toContain(`data: [S.glob("//Makefile"), S.glob("//config/**")]`)
    expect(declaration(source, "a-1")).toContain(`outFiles: ["//build/info.txt"]`)
    expect(declaration(source, "a-1")).toContain(`outDirs: ["//packages/a/dist", "//packages/b/dist"]`)
    expect(declaration(source, "a-1")).toContain("cache: false")
    expect(declaration(source, "a-1")).toContain(`sandbox: "none"`)
    // The step after it reads those outputs through the dependency, and its key holds the setup target's key.
    expect(declaration(source, "a-2")).toContain(`data: [S.glob("//packages/a/**"), step0]`)
    expect(declaration(source, "a-2")).toContain("sandbox: { network: true }")
  })

  it("keeps a chain narrowed only while every earlier step names both", () => {
    const middle = (extra: Partial<Step>): Step =>
      step("a:2", "make more", { inputs: ["more/**"], from: "a:2", ...extra })
    const last = step("a:3", "make test", { inputs: ["packages/a/**"], from: "a:3" })
    const all = targetsOf(inventory([job("a", [build({ outputs: [] }), middle({ outputs: ["out/**"] }), last])]))
    // A step that says it writes nothing declares no output.
    expect(declaration(all, "a-1")).not.toContain("outFiles")
    expect(declaration(all, "a-1")).not.toContain("outDirs")
    expect(declaration(all, "a-2")).toContain(`data: [S.glob("//more/**"), step0]`)
    expect(declaration(all, "a-2")).toContain(`outDirs: ["//out"]`)
    expect(declaration(all, "a-3")).toContain(`data: [S.glob("//packages/a/**"), step1]`)
    // The middle step does not say what it writes, so the step after it reads everything. The job then runs on a
    // machine of its own, where no step is held to its inputs.
    const gap = targetsOf(inventory([job("a", [build({ outputs: [] }), middle({}), last])]))
    expect(declaration(gap, "a-1")).toContain("data: []")
    expect(declaration(gap, "a-1")).toContain(`machine: "a"`)
    expect(declaration(gap, "a-2")).toContain("data: [step0]")
    expect(declaration(gap, "a-2")).not.toContain("outDirs")
    expect(declaration(gap, "a-3")).toContain("data: [repository, step1]")
    expect(declaration(gap, "a-3")).toContain(`sandbox: "none"`)
    // The first step names what it writes and not what it reads: nothing after it can stand on its own inputs.
    const blind = targetsOf(inventory([job("a", [
      step("a:1", "make dist", { outputs: ["dist/**"] }),
      middle({ outputs: ["out/**"] }),
      last
    ])]))
    expect(declaration(blind, "a-1")).toContain("data: []")
    expect(declaration(blind, "a-1")).not.toContain("outDirs")
    expect(declaration(blind, "a-2")).toContain("data: [step0]")
    expect(declaration(blind, "a-2")).not.toContain("outDirs")
    expect(declaration(blind, "a-3")).toContain("data: [repository, step1]")
  })

  it("treats outputs it cannot declare as one directory or one file as unknown", () => {
    for (const output of ["dist/*.js", "**", "../other/**", "/tmp/out", "./**", "packages/[ab]/dist/**"]) {
      const source = targetsOf(inventory([job("a", [build({ outputs: ["packages/a/dist/**", output] }), test])]))
      expect(declaration(source, "a-1"), output).toContain("data: []")
      expect(declaration(source, "a-1"), output).not.toContain("outDirs")
      expect(declaration(source, "a-2"), output).toContain("data: [repository, step0]")
    }
  })

  it("follows a recipe that names both across one working tree, and declares no outputs for a last step", () => {
    const source = targetsOf(inventory([
      job("build", [build({ id: "build:1", outputs: ["dist/**"] })], { source: "justfile", triggers: [] }),
      job("test", [step("test:1", "make test", { inputs: ["src/**"], outputs: ["report/**"], from: "test:1" })], {
        source: "justfile",
        triggers: [],
        needs: ["build"]
      })
    ]))
    expect(declaration(source, "build-1")).toContain(`outDirs: ["//dist"]`)
    expect(declaration(source, "test-1")).toContain(`data: [S.glob("//src/**"), step0]`)
    expect(declaration(source, "test-1")).toContain("sandbox: { network: true }")
    // Nothing relies on the last step, so what it writes is not declared.
    expect(declaration(source, "test-1")).not.toContain("outDirs")
  })

  it("declares no inputs or outputs on a setup target when the inputs do not fit in the one file", () => {
    const inputs = Array.from({ length: 4000 }, (_, index) => `packages/${"p".repeat(300)}-${index}/**`)
    const source = content(
      generate(inventory([job("a", [
        step("a:1", "make dist", { inputs, outputs: ["dist/**"], from: "a:1" }),
        step("a:2", "make test", { inputs, from: "a:2" })
      ])])),
      packagePath
    )
    expect(declaration(source, "a-1")).toContain("data: []")
    expect(source).not.toContain("outDirs")
    expect(declaration(source, "a-2")).toContain("data: [repository, step0]")
    expect(source).not.toContain("sandbox: {")
  })
})

describe("the size limit", () => {
  it("refuses targets too large for the one file", () => {
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
      job("j3", [step("ci:x-y", "exit 0")])
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
    expect(content(generated, workflowPath)).toContain(`os:\n          - self-hosted\n`)
  })

  it("keeps every label of a self-hosted runner, as the job names them", () => {
    const workflow = content(
      generate(inventory([
        job("a", [step("a:1", "t")], { runsOn: "self-hosted,linux,gpu" }),
        job("b", [step("b:1", "u")], { runsOn: "self-hosted,linux,gpu" })
      ])),
      workflowPath
    )
    expect(parseYaml(workflow).jobs.ci.strategy.matrix.os).toEqual([["self-hosted", "linux", "gpu"]])
    expect(workflow).toContain("key: smithers-ci-${{ join(matrix.os, '-') }}-${{ github.sha }}\n")
    // Beside a hosted runner of its own system, each of the two runs its own job's targets and not the other's.
    const beside = content(
      generate(inventory([
        job("a", [step("a:1", "t")], { runsOn: "self-hosted,linux,gpu" }),
        job("b", [step("b:1", "u")], { runsOn: "ubuntu-latest" })
      ])),
      workflowPath
    )
    expect(parseYaml(beside).jobs.ci.strategy.matrix.include).toEqual([
      { os: ["self-hosted", "linux", "gpu"], leg: 1, tools: "runner self-hosted,linux,gpu" },
      { os: "ubuntu-latest", leg: 2, tools: "runner ubuntu-latest" }
    ])
    const cached = (parseYaml(beside).jobs.ci.steps as ReadonlyArray<Record<string, unknown>>).find((entry) =>
      entry["uses"] === "actions/cache@v4"
    ) as { readonly with: { readonly key: string } }
    expect(cached.with.key).toBe("smithers-ci-${{ join(matrix.os, '-') }}-${{ matrix.leg }}-${{ github.sha }}")
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
    // Two working trees whose jobs need each other across the trees, against the order each tree runs in.
    const tree = (id: string, file: string, needs: ReadonlyArray<string>): Job =>
      job(id, [step(`${id}:1`, "x")], { source: "justfile", file, triggers: [], needs })
    expect(
      failureOf(inventory([
        tree("a1", "one/justfile", ["b2"]),
        tree("a2", "one/justfile", []),
        tree("b1", "two/justfile", ["a2"]),
        tree("b2", "two/justfile", [])
      ])).message
    ).toContain("the order the jobs of one working tree run in")
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
    expect(workflow).toContain("on:\n  - push\n# prettier-ignore\npermissions:")
    expect(workflow).toContain(`os:\n          - ubuntu-24.04\n`)
    expect(workflow).toContain(`mlugg/setup-zig@v2\n        with:\n          version: 0.14.0\n`)
    expect(workflow.indexOf("oven-sh/setup-bun@v2")).toBeLessThan(workflow.indexOf("mlugg/setup-zig@v2"))
    expect(workflow).toContain("# turbo (turbo.json) has no known setup action.")
    expect(workflow).toContain(`node-version: 24\n`)
    // Smithers build keeps its cache in a directory of the runner, outside the checkout.
    expect(stateDirectory).toBe("${{ runner.temp }}/smithers-ci")
    expect(smthrsRun(workflow)).toMatch(
      new RegExp(`smthrs ci '//\\.\\.\\.' --cache-dir "\\$\\{\\{ runner\\.temp }}/smithers-ci"$`)
    )
    // The runner keeps its results, what each step left and the compiled code of smthrs, and the run reads them.
    expect(workflow).toContain(
      `          path: |\n            ${stateDirectory}/cache\n            ${stateDirectory}/${contentStore}\n` +
        `            ${stateDirectory}/${keptFiles}\n            ${stateDirectory}/${compiledCode}\n`
    )
    expect(keptFiles).toBe("kept")
    expect(contentStore).toBe("cas")
    expect(workflow.indexOf(`            ${stateDirectory}/${compiledCode}`)).toBeLessThan(
      workflow.indexOf("smthrs ci")
    )
    expect(workflow).toContain(`        env:\n          NODE_COMPILE_CACHE: ${stateDirectory}/${compiledCode}\n`)
    // Nothing the workflow keeps or the workspace declares is in the checkout.
    expect(workflow).not.toContain(".flows")
    // A replay starts smthrs with the directory the workflow names, in the cache directory it gives Smithers build.
    expect(compiledCode).toBe(replayed)
  })

  it("pins each setup action where the repository's own jobs pin it", () => {
    // eliza's Bun pin check refuses any oven-sh/setup-bun that is not at a reviewed commit, and read the generated
    // workflow's `@v2` as a violation. The generated workflow now uses each action at the ref the CI's jobs use most.
    const bun = "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6"
    const node = "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1"
    const workflow = content(
      generate(inventory([job("ci.yml:test", [step("t:1", "bun test")])], {
        toolchains: [
          { name: "bun", source: ".github/workflows/ci.yml", version: "1.4.2", job: "ci.yml:test", action: bun },
          { name: "bun", source: ".github/workflows/b.yml", version: "1.4.2", job: "b.yml:b", action: bun },
          {
            name: "bun",
            source: ".github/workflows/c.yml",
            version: "1.4.2",
            job: "c.yml:c",
            action: "oven-sh/setup-bun@v2"
          },
          { name: "node", source: ".github/workflows/ci.yml", version: "24.15.0", job: "ci.yml:test", action: node },
          { name: "python", source: ".python-version", version: "3.12" }
        ]
      })),
      workflowPath
    )
    expect(workflow).toContain(`      - uses: ${bun}\n        with:\n          bun-version: 1.4.2\n`)
    expect(workflow).not.toContain("oven-sh/setup-bun@v2")
    // smithers-ci's own Node is set up with the same action, so it is pinned the same way.
    expect(workflow).not.toContain("actions/setup-node@v4")
    expect(workflow.split(`uses: ${node}`).length - 1).toBe(2)
    // An action no job of the repository uses is written as smithers-ci knows it.
    expect(workflow).toContain("      - uses: actions/setup-python@v5\n")
  })

  it("chooses the ref most of the repository's setup steps use, the first in order among equals", () => {
    const tool = (action: string | undefined) => ({
      name: "bun",
      source: "x",
      ...(action === undefined ? {} : { action })
    })
    expect(actionRefs([tool("a/b@2"), tool("a/b@1"), tool("a/b@2"), tool(undefined), tool("@1"), tool("a/b/sub@3")]))
      .toEqual(new Map([["a/b", "2"], ["a/b/sub", "3"]]))
    expect(actionRefs([tool("a/b@2"), tool("a/b@1")])).toEqual(new Map([["a/b", "1"]]))
    expect(actionRefs([tool("a/b@1"), tool("a/b@2")])).toEqual(new Map([["a/b", "1"]]))
  })

  it("installs the version a file pins for a job that sets the tool up with none it can read", () => {
    const generated = generate(inventory([job("ci.yml:test", [step("t:1", "node test.js")])], {
      toolchains: [
        { name: "node", source: ".github/workflows/ci.yml", job: "ci.yml:test" },
        { name: "node", source: ".nvmrc", version: "20" }
      ]
    }))
    expect(content(generated, workflowPath)).toContain(
      `      - uses: actions/setup-node@v4\n        with:\n          node-version: 20\n`
    )
    expect(content(generated, notesPath)).toContain(
      "- node: ci.yml:test sets it up with no version smithers-ci can read, so its steps run with node 20 (.nvmrc).\n"
    )
    expect(content(generated, packagePath)).toContain(`// Not reproduced from the original CI: see ${notesPath}`)
  })

  it("chooses one version of a tool for the steps whose jobs name none, and names what it leaves out", () => {
    const generated = generate(inventory([job("ci.yml:test", [step("t:1", "make")])], {
      toolchains: [
        // The CI's job names Node, so a pin file's other version is no loss.
        { name: "node", source: ".github/workflows/ci.yml", version: "18", job: "ci.yml:test" },
        { name: "node", source: ".nvmrc", version: "22" },
        // Two pin files disagree.
        { name: "zig", source: "build.zig.zon", version: "0.15.1" },
        { name: "zig", source: "a-later-file", version: "0.14.0" },
        // Only jobs that are not CI name Go: the first version among them is used, and nothing is noted.
        { name: "go", source: ".github/workflows/nightly.yml", job: "nightly.yml:soak" },
        { name: "go", source: ".github/workflows/release.yml", version: "1.22", job: "release.yml:publish" },
        { name: "go", source: ".github/workflows/weekly.yml", version: "1.21", job: "weekly.yml:soak" },
        // A pin file names Bun with no version: a job that is not CI is not asked for one.
        { name: "bun", source: "package.json" },
        { name: "bun", source: ".github/workflows/release.yml", version: "1.2.0", job: "release.yml:publish" }
      ]
    }))
    const workflow = content(generated, workflowPath)
    expect(workflow).toContain(`      - uses: oven-sh/setup-bun@v2\n      - uses: actions/setup-go@v5\n`)
    expect(workflow).toContain(`          go-version: >-\n            1.22\n      - uses: actions/setup-node@v4\n`)
    expect(workflow).toContain(`          node-version: 18\n`)
    expect(workflow).toContain(`          version: 0.14.0\n`)
    expect(content(generated, notesPath).split("\n").filter((line) => line.startsWith("- "))).toEqual([
      "- zig 0.15.1 (build.zig.zon) is not installed: a step whose job names no version runs with zig 0.14.0 " +
      "(a-later-file)."
    ])
  })

  it("writes the same workflow when the inventory was read with the generated workflow in place", () => {
    const jobs = [
      job("justfile:test", [step("t:1", "echo ok")], { source: "justfile", file: "justfile", triggers: [] })
    ]
    const first = generate(inventory(jobs, { toolchains: [{ name: "just", source: "justfile" }] }))
    // What the importer reads from the workflow the first run wrote: its Node, and `just` a second time.
    const second = generate(inventory(jobs, {
      toolchains: [
        { name: "just", source: workflowPath },
        { name: "just", source: "justfile" },
        { name: "node", source: workflowPath, version: "24" }
      ]
    }))
    expect(second).toEqual(first)
    expect(content(first, workflowPath)).toContain(
      `          node-version: 24\n      - name: Generated files are up to date\n` +
        `        run: >-\n          npx --yes --package=smithers-ci@${releaseVersion} smithers-ci apply --check\n` +
        `      - uses: extractions/setup-just@v3\n`
    )
  })

  it("installs the read sandbox on the runner when a target is held to its inputs, and only then", () => {
    const held = inventory([job("a", [step("a:1", "x", { inputs: ["src/**"], from: "a:1" })])])
    const workflow = content(generate(held), workflowPath)
    expect(content(generate(held), packagePath)).toContain("sandbox: { network: true }")
    // Linux targets are confined by bubblewrap, which an Ubuntu runner does not have.
    expect(workflow).toContain("        if: runner.os == 'Linux' && runner.environment == 'github-hosted'\n")
    expect(workflow).toContain("apt-get install -y -qq --no-install-recommends bubblewrap")
    expect(workflow).toContain("sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0")
    expect(workflow.indexOf("bubblewrap\n")).toBeLessThan(workflow.indexOf("smthrs ci"))
    expect(workflow).not.toContain("strace")
    // No target is confined, and no job has a machine: nothing to install for either. The step is observed, and
    // smithers-ci records it with its own program on a GitHub-hosted runner, so nothing is installed for that
    // either.
    const opened = generate(inventory([job("a", [step("a:1", "x")], { source: "justfile", file: "Justfile" })]))
    const open = content(opened, workflowPath)
    expect(content(opened, packagePath)).toContain("observe: {")
    expect(open).not.toContain("Install the read sandbox")
    expect(open).not.toContain("Give each job its own /tmp")
    expect(open).not.toContain("tracer")
    expect(open).not.toContain("strace")
    // Inputs too large for the one file: every target runs in the open, so the step is left out.
    const inputs = Array.from({ length: 4000 }, (_, index) => `packages/${"p".repeat(300)}-${index}/**`)
    const large = generate(inventory([job("a", [step("a:1", "x", { inputs, from: "a:1" })])]))
    expect(content(large, packagePath)).not.toContain("sandbox: {")
    expect(content(large, packagePath)).toContain("observe: {")
    expect(content(large, workflowPath)).not.toContain("Install the read sandbox")
    expect(content(large, workflowPath)).not.toContain("strace")
  })

  it("installs what keeps the cache's token from a step on a Linux runner, when the repository names a cache", () => {
    // A job with no machine: one with a machine has bubblewrap from the step that gives it its own /tmp.
    const steps = inventory([job("a", [step("a:1", "x")], { source: "justfile", file: "Justfile" })])
    const installs = [
      "        shell: bash",
      "        run: |",
      "          if ! command -v bwrap >/dev/null 2>&1 &&",
      "            command -v apt-get >/dev/null 2>&1; then",
      "            sudo apt-get update -qq &&",
      "              sudo apt-get install -y -qq --no-install-recommends bubblewrap",
      "          fi",
      "          if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]",
      "          then",
      "            sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0",
      "          fi",
      ""
    ].join("\n")
    // The cache is named in the repository's settings: the step runs only when it is.
    const open = content(generate(steps), workflowPath)
    expect(open).toContain(
      "      - name: Keep the cache's token from the steps\n" +
        "        if: >-\n          runner.os == 'Linux' && vars.SMITHERS_CACHE_URL != '' &&\n" +
        "          runner.environment == 'github-hosted'\n" + installs
    )
    // The workflow says where a step can still read the token.
    expect(commentsOf(open)).toContain(
      "That takes bubblewrap, on Linux. On macOS and Windows a step can read the token it runs beside."
    )
    expect(open.indexOf("Keep the cache's token")).toBeLessThan(open.indexOf("smthrs ci"))
    // The cache was named when the files were written: the step always runs.
    const named = content(generate(steps, { cache: "https://cache.example.com" }), workflowPath)
    expect(named).toContain(
      "      - name: Keep the cache's token from the steps\n        if: runner.os == 'Linux' && runner.environment == 'github-hosted'\n" +
        installs
    )
    // A workflow that installs the read sandbox has bubblewrap already.
    const held = inventory([job("a", [step("a:1", "x", { inputs: ["src/**"], from: "a:1" })])])
    expect(content(generate(held), workflowPath)).not.toContain("Keep the cache's token from the steps")
    expect(content(generate(held), workflowPath)).toContain("Install the read sandbox")
    // So has one whose job runs on a machine of its own: bubblewrap is set up by one step, never by two.
    const machine = content(generate(inventory([job("a", [step("a:1", "x")])])), workflowPath)
    expect(machine).toContain("      - name: Give each job its own /tmp\n")
    expect(machine).not.toContain("Keep the cache's token from the steps")
    expect(machine.match(/--no-install-recommends bubblewrap/g)).toHaveLength(1)
    expect(machine.match(/sysctl -w kernel.apparmor_restrict_unprivileged_userns=0/g)).toHaveLength(1)
    // Each of the three steps asks the package index for nothing on a runner that has bubblewrap.
    for (const workflow of [open, machine, content(generate(held), workflowPath)]) {
      expect(workflow).toContain("          if ! command -v bwrap >/dev/null 2>&1 &&\n")
    }
  })

  it("uses the repository's Node and defaults its triggers and runner", () => {
    const workflow = content(
      generate(inventory([job("a", [step("a:1", "x")], { source: "justfile", name: "test", triggers: [] })], {
        toolchains: [{ name: "node", source: ".nvmrc", version: "22.20.0" }]
      })),
      workflowPath
    )
    expect(workflow).toContain("on:\n  - pull_request\n  - push\n")
    expect(workflow).toContain(`os:\n          - ubuntu-latest\n`)
    // smithers-ci checks the generated files on its own Node; the repository's Node is set up after that.
    const versions = [...workflow.matchAll(/node-version: (.+)/g)].map((match) => match[1])
    expect(versions).toEqual(["24", "22.20.0"])
    expect(workflow.indexOf("apply --check")).toBeLessThan(workflow.indexOf(`node-version: 22.20.0`))
  })
})

describe("tool versions", () => {
  const file = ".github/workflows/ci.yml"
  const matrixNode = { name: "node", source: file, version: "${{ matrix.node }}", job: "ci.yml:test" }
  const test = job("ci.yml:test", [step("ci.yml:test:1", "node test.js")], {
    runsOn: "ubuntu-latest",
    matrix: [{ node: "18" }, { node: "20" }]
  })
  const lint = job("ci.yml:lint", [step("ci.yml:lint:1", "node lint.js")], { runsOn: "ubuntu-latest" })
  const pinned = (id: string, version: string) => ({ name: "node", source: file, version, job: id })
  const include = (generated: ReadonlyArray<GeneratedFile>) =>
    (parseYaml(content(generated, workflowPath)) as {
      readonly jobs: { readonly ci: { readonly strategy: { readonly matrix: { readonly include?: unknown } } } }
    }).jobs.ci.strategy.matrix.include

  it("runs each matrix variant under its own version, on its own machine, with its own key", () => {
    const generated = generate(inventory([test], { toolchains: [matrixNode] }))
    expect(include(generated)).toEqual([
      { os: "ubuntu-latest", leg: 1, tools: "node 18", "version-node": 18 },
      { os: "ubuntu-latest", leg: 2, tools: "node 20", "version-node": 20 }
    ])
    const workflow = content(generated, workflowPath)
    expect(workflow).toContain("          node-version: ${{ matrix.version-node }}\n")
    expect(smthrsRun(workflow)).toContain(`$(sed -n 's/^\${{ matrix.leg }} //p' ${legsPath}) --jobs 1`)
    expect(workflow).not.toContain("'//...'")
    // Each machine restores only results made under its own versions.
    expect(workflow).toContain("key: smithers-ci-${{ matrix.os }}-${{ matrix.leg }}-${{ github.sha }}")
    expect(workflow).toContain("restore-keys: smithers-ci-${{ matrix.os }}-${{ matrix.leg }}-\n")
    expect(content(generated, legsPath)).toBe(
      "# Generated by smithers-ci. Do not edit.\n1 //:ci.yml-test-1--18\n2 //:ci.yml-test-1--20\n"
    )
    const targets = content(generated, packagePath)
    expect(targets).toContain(JSON.stringify("# Runs under node 18.\nbash -e -c 'node test.js'"))
    expect(targets).toContain(JSON.stringify("# Runs under node 20.\nbash -e -c 'node test.js'"))
    expect(content(generated, notesPath)).toBe("")
  })

  it("keeps one machine and today's workflow when every step runs under the same version", () => {
    const generated = generate(inventory([{ ...test, matrix: [{ node: "20" }] }], { toolchains: [matrixNode] }))
    expect(include(generated)).toBeUndefined()
    const workflow = content(generated, workflowPath)
    expect(workflow).toContain(`          node-version: 20\n`)
    expect(smthrsRun(workflow)).toContain("smthrs ci '//...'")
    expect(workflow).toContain("key: smithers-ci-${{ matrix.os }}-${{ github.sha }}")
    expect(generated.some((entry) => entry.path === legsPath)).toBe(false)
    expect(content(generated, packagePath)).not.toContain("# Runs under")
  })

  it("does not make a step wait for a job that runs under other versions, and says so", () => {
    const generated = generate(inventory([lint, { ...test, needs: ["ci.yml:lint"] }], {
      toolchains: [matrixNode, pinned("ci.yml:lint", "22")]
    }))
    const targets = content(generated, packagePath)
    // No target depends on another: each `data` holds only the repository.
    expect(targets.match(/data: \[repository\]/g)).toHaveLength(3)
    expect(content(generated, notesPath)).toContain(
      "- ci.yml:test: runs with node 18, so it does not wait for ci.yml:lint, which runs with node 22. " +
        "The workflow still fails when either fails.\n"
    )
    expect(content(generated, legsPath).split("\n").slice(1, -1)).toEqual([
      "1 //:ci.yml-test-1--18",
      "2 //:ci.yml-test-1--20",
      "3 //:ci.yml-lint-1"
    ])
  })

  it("makes a step wait for the variant of a needed job that runs under its versions", () => {
    const build = {
      ...test,
      id: "ci.yml:build",
      name: "build",
      steps: [step("ci.yml:build:1", "node build.js")]
    }
    const generated = generate(inventory([build, { ...test, needs: ["ci.yml:build"] }], {
      toolchains: [matrixNode, { ...matrixNode, job: "ci.yml:build" }]
    }))
    const targets = content(generated, packagePath)
    const dataOf = (title: string): string => {
      const start = targets.indexOf(`// ${title}`)
      return /data: \[(.*)\]/.exec(targets.slice(start))?.[1] ?? ""
    }
    const variable = (label: string): string => new RegExp(`"${label}": (step\\d+)`).exec(targets)?.[1] as string
    const tests = [...targets.matchAll(/\/\/ ci\.yml:test \/ ci\.yml:test:1\nconst (step\d+)[\s\S]*?data: \[(.*)\]/g)]
      .map((match) => [match[1], match[2]])
    expect(dataOf("ci.yml:test / ci.yml:test:1")).toContain("repository")
    expect(tests).toEqual([
      [variable("ci.yml-test-1--18"), `repository, ${variable("ci.yml-build-1--18")}`],
      [variable("ci.yml-test-1--20"), `repository, ${variable("ci.yml-build-1--20")}`]
    ])
    expect(content(generated, notesPath)).toBe("")
  })

  it("runs a step whose job names no version under the repository's, or else the first a job names", () => {
    const pin = { name: "node", source: ".nvmrc", version: "20" }
    expect(content(generate(inventory([lint, test], { toolchains: [matrixNode, pin] })), legsPath)).toBe(
      "# Generated by smithers-ci. Do not edit.\n1 //:ci.yml-test-1--18\n2 //:ci.yml-lint-1\n2 //:ci.yml-test-1--20\n"
    )
    expect(content(generate(inventory([lint, test], { toolchains: [matrixNode] })), legsPath)).toBe(
      "# Generated by smithers-ci. Do not edit.\n1 //:ci.yml-lint-1\n1 //:ci.yml-test-1--18\n2 //:ci.yml-test-1--20\n"
    )
  })

  it("takes the first version a job with no named runner fills", () => {
    const { runsOn: _runsOn, ...anywhere } = test
    const generated = generate(inventory([lint, anywhere], { toolchains: [matrixNode] }))
    expect(content(generated, legsPath)).toContain("1 //:ci.yml-lint-1\n")
  })

  it("gives a variant the matrix does not fill the repository's version", () => {
    const generated = generate(inventory([{ ...test, matrix: [{ node: "18" }, { node: "" }, { other: "x" }] }], {
      toolchains: [matrixNode, { name: "node", source: ".nvmrc", version: "22" }]
    }))
    expect(content(generated, legsPath).split("\n").slice(1, -1)).toEqual([
      "1 //:ci.yml-test-1--18",
      // The two variants with no version run under the repository's, each on a machine of its own.
      "2 //:ci.yml-test-1--",
      "2 //:ci.yml-test-1--x"
    ])
  })

  it("runs one step for two jobs only when they run it under the same versions", () => {
    // Each job is held to the files it names, so an equal step of the two can be one target.
    const install = (id: string) =>
      job(id, [step(`${id}:1`, "npm ci", { inputs: ["package.json"] })], { runsOn: "ubuntu-latest" })
    const targetsFor = (second: string) =>
      content(
        generate(inventory([install("ci.yml:a"), install("ci.yml:b")], {
          toolchains: [pinned("ci.yml:a", "20"), pinned("ci.yml:b", second)]
        })),
        packagePath
      ).match(/S\.Shell\.Test\(/g)
    expect(targetsFor("20")).toHaveLength(1)
    expect(targetsFor("22")).toHaveLength(2)
  })

  it("keeps a machine for each runner and versions, with only the targets for its system", () => {
    const generated = generate(inventory([{
      ...test,
      runsOn: "${{ matrix.os }}",
      matrix: [
        { os: "ubuntu-latest", node: "18" },
        { os: "macos-latest", node: "20" },
        // Windows targets never run, so this version makes no machine.
        { os: "windows-latest", node: "16" }
      ]
    }, job("ci.yml:any", [step("ci.yml:any:1", "x")])], { toolchains: [matrixNode] }))
    expect(include(generated)).toEqual([
      { os: "macos-latest", leg: 1, tools: "node 18", "version-node": 18 },
      // A job on macOS is a runner job of its own: a macOS runner gives two jobs one `/tmp`.
      {
        os: "macos-latest",
        leg: 2,
        tools: "node 20, job ci.yml:test (node 20, os macos-latest)",
        "version-node": 20
      },
      { os: "ubuntu-latest", leg: 3, tools: "node 18", "version-node": 18 }
    ])
    expect(content(generated, legsPath).split("\n").slice(1, -1)).toEqual([
      "1 //:ci.yml-any-1",
      "2 //:ci.yml-test-1--20--macos-latest",
      "3 //:ci.yml-any-1",
      "3 //:ci.yml-test-1--18--ubuntu-latest"
    ])
  })

  it("sets up a tool every machine shares once, and one it cannot install with a comment", () => {
    const generated = generate(inventory([test], {
      toolchains: [
        matrixNode,
        { name: "pnpm", source: file, job: "ci.yml:test" },
        { name: "python", source: ".python-version", version: "3.12" },
        { name: "ruby", source: file, version: "${{ matrix.node }}", job: "ci.yml:test" }
      ]
    }))
    const workflow = content(generated, workflowPath)
    expect(workflow).toContain(`          python-version: >-\n            3.12\n`)
    expect(workflow).toContain("      - uses: pnpm/action-setup@v4\n      - uses: actions/setup-python@v5\n")
    expect(workflow).toContain(`# ruby (${file}) has no known setup action.`)
    expect(include(generated)).toEqual([
      { os: "ubuntu-latest", leg: 1, tools: "node 18, python 3.12, ruby 18", "version-node": 18 },
      { os: "ubuntu-latest", leg: 2, tools: "node 20, python 3.12, ruby 20", "version-node": 20 }
    ])
  })

  it("names a version a job sets up twice, and keeps a line break out of a target's text", () => {
    const generated = generate(inventory([{ ...job("ci.yml:a", [step("ci.yml:a:1", "x")]) }, {
      ...job("ci.yml:b", [step("ci.yml:b:1", "y")])
    }], {
      toolchains: [
        pinned("ci.yml:a", "18"),
        pinned("ci.yml:a", "20"),
        pinned("ci.yml:b", "22\nrm -rf /")
      ]
    }))
    expect(content(generated, notesPath)).toContain(
      "- node 20 is not installed for ci.yml:a: the job sets node up twice, and its steps run with node 18.\n"
    )
    expect(content(generated, packagePath)).toContain(JSON.stringify("# Runs under node 22 rm -rf /.\nbash -e -c 'y'"))
  })

  it("treats a version a job of one shared working tree names as the repository's", () => {
    const recipe = job("justfile:test", [step("justfile:test:1", "x")], { source: "justfile", file: "justfile" })
    const generated = generate(inventory([recipe], {
      toolchains: [{ name: "node", source: "justfile", version: "18", job: "justfile:test" }]
    }))
    expect(content(generated, workflowPath)).toContain(`          node-version: 18\n`)
    expect(generated.some((entry) => entry.path === legsPath)).toBe(false)
  })
})
