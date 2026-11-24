/**
 * The generated workflow's kept steps, cache token and size fallback, and the texts the generator reads and writes.
 */

import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import { describe, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"
import { type Ci, type Inventory, type Job, type KeptStep, type Step } from "../../src/contract/Inventory.vibe"
import { forShell, forText } from "../../src/generate/Expressions.vibe"
import { files } from "../../src/generate/index.vibe"
import { keptNotes, keptRuns, keptSteps } from "../../src/generate/Kept.vibe"
import { notesPath, packagePath, workflowPath } from "../../src/generate/Render.ts"
import { planSteps, type StepTarget } from "../../src/generate/Steps.vibe"
import * as Yaml from "../../src/generate/Yaml.vibe"
import { readWorkflow } from "../../src/inventory/GithubActions.vibe"

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

const inventory = (jobs: ReadonlyArray<Job>): Ci =>
  ({
    version: 1,
    repository: "example/repo",
    commit: "0".repeat(40),
    toolchains: [],
    jobs
  }) satisfies Inventory as unknown as Ci

const content = (document: Ci, path: string): string =>
  Effect.runSync(files(document)).find((file) => file.path === path)?.content ?? ""

type Steps = ReadonlyArray<Readonly<Record<string, unknown>>>

/** The steps as GitHub reads them from the generated workflow. */
const read = (items: ReadonlyArray<Yaml.Item>): Steps =>
  (parseYaml(Yaml.document(Yaml.mapping([Yaml.entry("steps", Yaml.sequence(items))]))) as { readonly steps: Steps })
    .steps

const stepsOf = (workflow: string): Steps =>
  (parseYaml(workflow) as { readonly jobs: { readonly ci: { readonly steps: Steps } } }).jobs.ci.steps

describe("a kept step and the step that restores its job's files", () => {
  const main = job("main", [])
  const place = { job: main, variant: {}, machine: "m", entry: "matrix.os == 'ubuntu-latest'" }

  it("runs only when the restore of its own files succeeded, also under always()", () => {
    const [restore, kept] = read(keptSteps({ uses: "actions/upload-artifact@v4", if: "always()" }, place, 2, 5))
    expect(restore).toMatchObject({
      id: "smthrs_files_5",
      // The restore itself is tried as the repository's own condition says.
      if: "${{ matrix.os == 'ubuntu-latest' && (always()) }}"
    })
    expect(kept?.["if"]).toBe(
      "${{ matrix.os == 'ubuntu-latest' && steps.smthrs_files_5.outcome == 'success' && (always()) }}"
    )
  })

  it("gives each restore of a workflow an id of its own, which no kept step's id can be", () => {
    const tested = job("main", [step("main:1", "echo covered > coverage.txt")], {
      runsOn: "ubuntu-latest",
      kept: [
        { uses: "codecov/codecov-action@v5", id: "smthrs_files" },
        { uses: "actions/upload-artifact@v4", if: "always()" }
      ]
    })
    const steps = stepsOf(content(inventory([tested]), workflowPath))
    const ids = steps.flatMap((each) => each["id"] === undefined ? [] : [each["id"]])
    expect(ids).toEqual(["smthrs_files_0", "smthrs_files-0", "smthrs_files_1"])
    expect(steps.filter((each) => each["uses"] === "actions/upload-artifact@v4").map((each) => each["if"])).toEqual([
      "${{ matrix.os == 'ubuntu-latest' && steps.smthrs_files_1.outcome == 'success' && (always()) }}"
    ])
  })

  it("reads a condition wrapped in spaces as the one expression it holds", () => {
    const [, kept] = read(keptSteps({ uses: "a/b@v1", if: "  ${{ failure() }}  " }, place, 0, 0))
    expect(kept?.["if"]).toBe(
      "${{ matrix.os == 'ubuntu-latest' && steps.smthrs_files_0.outcome == 'success' && (failure()) }}"
    )
  })
})

describe("a kept step the generated workflow cannot write for a variant", () => {
  const target = (label: string, of: Job, variant: Readonly<Record<string, string>>): StepTarget =>
    ({ label, job: of.id, variant, machine: `${of.id} ${JSON.stringify(variant)}` }) as unknown as StepTarget

  /** What the workflow runs and what it leaves out, for one kept step of a job with the variants given. */
  const decided = (kept: KeptStep, variants: ReadonlyArray<Readonly<Record<string, string>>> = [{}]) => {
    const tested = job("main", [], { runsOn: "ubuntu-latest", matrix: variants, kept: [kept] })
    const plan = { targets: variants.map((variant, index) => target(`t${index}`, tested, variant)), legs: [] }
    return {
      runs: keptRuns([tested], plan).map((run) => [run.place.variant, run.index]),
      notes: keptNotes([tested], plan)
    }
  }

  const otherKeys = "an expression reads the matrix other than as matrix.<key>, and the matrix of this workflow " +
    "holds other keys."

  it.each([
    ["the whole matrix", { with: { name: "r-${{ toJSON(matrix) }}" } }],
    ["every value of the matrix", { with: { name: "r-${{ join(matrix.*, '-') }}" } }],
    ["a key in brackets", { env: { WHO: "${{ matrix['os'] }}" } }],
    ["every value under a key", { name: "${{ join(matrix.node.*, ',') }}" }],
    ["a key in brackets under a key", { continueOnError: "${{ matrix.node['lts'] }}" }],
    ["the matrix in its condition", { if: "contains(toJSON(matrix), 'x')" }],
    ["the matrix in its time limit", { timeoutMinutes: "${{ fromJSON(toJSON(matrix)).minutes }}" }]
  ])("is left out, with a note, when it reads %s", (_name, more) => {
    expect(decided({ uses: "a/b@v1", ...more })).toEqual({ runs: [], notes: [`main: a/b@v1 is not run: ${otherKeys}`] })
  })

  it("is written when `matrix` is text, part of another name, or read by key", () => {
    const kept: KeptStep = {
      uses: "a/b@v1",
      if: "github.ref == 'matrix' && needs.matrix.result == 'x' && my_matrix == matrix-x && matrix.Node != 'matrix.*'",
      with: { name: "${{ format('{0}', matrix.node) }}", path: "plain" }
    }
    expect(decided(kept, [{ node: "20" }])).toEqual({ runs: [[{ node: "20" }, 0]], notes: [] })
  })

  it("is left out where a value it decides by is true or false, which a variant holds only as text", () => {
    const variants = [{ coverage: "true", os: "a" }, { coverage: "false", os: "b" }, { coverage: "yes", os: "c" }]
    const outcome = decided({ uses: "codecov/codecov-action@v5", if: "matrix.Coverage" }, variants)
    // The directory of a machine keeps its number, whether or not the step runs there.
    expect(outcome.runs).toEqual([[variants[2], 2]])
    expect(outcome.notes).toEqual([
      "main (coverage true, os a): codecov/codecov-action@v5 is not run: an expression reads matrix.coverage, " +
      "which is true here: this workflow can write it only as text, which GitHub does not read as true or false.",
      "main (coverage false, os b): codecov/codecov-action@v5 is not run: an expression reads matrix.coverage, " +
      "which is false here: this workflow can write it only as text, which GitHub does not read as true or false."
    ])
    const compared = decided({ uses: "a/b@v1", with: { flag: "${{ matrix.coverage == true }}" } }, [variants[0]!])
    expect(compared.runs).toEqual([])
    expect(compared.notes).toHaveLength(1)
  })

  it("keeps a hyphenated property verbatim in conditions and inputs", () => {
    const property = "github.event.client_payload.run-matrix.os"
    const kept = { uses: "a/b@v1", if: "github.event.inputs.use-matrix", with: { name: "${{ " + property + " }}" } }
    expect(decided(kept).notes).toEqual([])
    const place = { job: job("main", []), variant: {}, machine: "m", entry: "true" }
    const [, written] = read(keptSteps(kept, place, 0, 0))
    expect(written?.["with"]).toEqual(kept.with)
    expect(written?.["if"]).toContain(kept.if)
  })

  it("omits a zero matrix condition and a boolean it could only write as quoted text", () => {
    expect(decided({ uses: "a/b@v1", if: "matrix.shard" }, [{ shard: "0" }, { shard: "1" }]).runs)
      .toEqual([[{ shard: "1" }, 1]])
    expect(decided({ uses: "a/b@v1", continueOnError: "${{ MATRIX.flag }}" }, [{ Flag: "false" }]).runs)
      .toEqual([])
  })

  it.each(["${{ GitHub.Job }}-logs", "${{ github['job'] }}"])(
    "omits an input that reads the original job ID",
    (name) => {
      const kept = { uses: "actions/upload-artifact@v4", with: { name } }
      expect(decided(kept).notes[0]).toContain("github.job")
      expect(decided(kept).runs).toEqual([])
      expect(decided({ ...kept, with: { name: "${{ format('github.job', github['ref']) }}" } }).notes).toEqual([])
    }
  )

  it("is written where true or false is only printed: the text is the same either way", () => {
    const kept: KeptStep = {
      uses: "a/b@v1",
      with: { flag: "${{ matrix.Coverage }}", plain: "${{ matrix.coverage }}", other: "${{ matrix.missing == 'x' }}" }
    }
    expect(decided(kept, [{ coverage: "false" }])).toEqual({ runs: [[{ coverage: "false" }, 0]], notes: [] })
  })

  it.each([
    ["text before an expression", "run-${{ matrix.mode }}"],
    ["text after an expression", "${{ matrix.mode }} == 'fast'"],
    ["two expressions", "${{ success() }}${{ matrix.mode }}"]
  ])("is left out when its condition holds %s", (_name, condition) => {
    expect(decided({ uses: "a/b@v1", if: condition }, [{ mode: "fast" }])).toEqual({
      runs: [],
      notes: [
        "main (mode fast): a/b@v1 is not run: its condition holds text beside a ${{ }}, which is no one expression."
      ]
    })
  })

  it("is named in the notes of the generated files, and absent from the workflow", () => {
    const tested = job("main", [step("main:1", "echo covered > coverage.txt")], {
      runsOn: "ubuntu-latest",
      kept: [{ uses: "actions/upload-artifact@v4", with: { name: "r-${{ join(matrix.*, '-') }}" } }]
    })
    const document = inventory([tested])
    expect(content(document, workflowPath)).not.toContain("actions/upload-artifact")
    expect(content(document, notesPath)).toContain(`- main: actions/upload-artifact@v4 is not run: ${otherKeys}\n`)
  })
})

describe("the notes of the generated files", () => {
  it("records each checkout setting the shared runner leaves at its default", () => {
    const parsed = readWorkflow(
      ".github/workflows/ci.yml",
      [
        "on: push",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "        with: { fetch-depth: 0, fetch-tags: true, persist-credentials: false }",
        "      - run: echo ok"
      ].join("\n")
    )
    const notes = content(inventory(parsed.jobs), notesPath)
    for (
      const setting of [
        "fetch-depth is left at 1",
        "fetch-tags is left at false",
        "persist-credentials is left at true"
      ]
    ) {
      expect(notes).toContain("build step 1: " + setting + " by the generated checkout")
    }
  })

  it("name each job the inventory leaves out, with why", () => {
    const options = { left: [{ job: "deploy", reasons: [{ feature: "secrets", detail: "reads DEPLOY_KEY" }] }] }
    const generated = Effect.runSync(files(inventory([job("a", [step("a:1", "x")])]), options))
    expect(generated.find((file) => file.path === notesPath)?.content).toContain("- deploy: not in this workflow: ")
  })
})

describe("the cache token of the generated workflow", () => {
  it("is the one that writes only on the default branch, and the read token for a pull request or another branch", () => {
    const workflow = content(inventory([job("a", [step("a:1", "x")])]), workflowPath)
    const build = stepsOf(workflow).find((each) => String(each["run"]).includes("smthrs ci"))
    expect((build?.["env"] as Record<string, string>)["SMITHERS_CACHE_TOKEN"]).toBe(
      "${{ github.event_name == 'pull_request' && secrets.SMITHERS_CACHE_READ_TOKEN || " +
        "github.ref_type != 'branch' && secrets.SMITHERS_CACHE_READ_TOKEN || " +
        "github.ref_name != github.event.repository.default_branch && secrets.SMITHERS_CACHE_READ_TOKEN || " +
        "github.event_name != 'pull_request' && github.ref_type == 'branch' && " +
        "github.ref_name == github.event.repository.default_branch && " +
        "secrets.SMITHERS_CACHE_TOKEN || '' }}"
    )
  })
})

describe("targets too large to be held to their inputs", () => {
  const inputs = Array.from({ length: 4000 }, (_, index) => `packages/${"p".repeat(300)}-${index}/**`)
  const held = (id: string): Job => job(id, [step(`${id}:1`, `echo ${id}`, { inputs, from: `${id}:1` })])

  it("give each job of a workflow a machine of its own, where it was held to its inputs before", () => {
    const small = content(
      inventory([job("a", [step("a:1", "echo a", { inputs: ["src/**"], from: "a:1" })])]),
      packagePath
    )
    expect(small).toContain("sandbox: { network: true }")
    expect(small).not.toContain("machine:")
    const document = inventory([held("a"), held("b")])
    const source = content(document, packagePath)
    expect(source).not.toContain("sandbox: {")
    expect(source).toContain("machine: \"a\"")
    expect(source).toContain("machine: \"b\"")
    const workflow = content(document, workflowPath)
    expect(workflow).toContain("Give each job its own /tmp")
    expect(workflow).toContain("SMTHRS_MACHINE_OWN_TMP: required")
  })

  it("plans a machine for every job of a workflow when asked for targets not held to their inputs", () => {
    const document = inventory([held("a"), job("m", [step("m:1", "make")], { source: "makefile", file: "Makefile" })])
    const machines = (narrowed: boolean): ReadonlyArray<string | undefined> =>
      Result.getOrThrow(planSteps(document, narrowed)).targets.map((target) => target.machine)
    expect(machines(true)).toEqual([undefined, undefined])
    expect(Result.getOrThrow(planSteps(document)).targets.map((target) => target.machine)).toEqual(machines(true))
    // A job of a Makefile shares the one working tree with the others of its file, held or not.
    expect(machines(false)).toEqual(["a", undefined])
  })

  it("are refused when they do not fit that way either", () => {
    const large = inventory([job("a", [step("a:1", `echo ${"x".repeat(1024 * 1024)}`)])])
    expect(Effect.runSync(Effect.flip(files(large)))).toMatchObject({ code: "unsupported", part: "generate" })
  })
})

describe("an expression in text", () => {
  it("is read up to the last }} and no further, however many ${{ follow it", () => {
    expect(forText("${{ matrix.a }} and ${{ never closed", { a: "1" })).toBe("1 and ${{ never closed")
    expect(forShell("no expression at all", {})).toBe("no expression at all")
    expect(forShell("only a closer }}", {})).toBe("only a closer }}")
    expect(forText("${{ secrets.X }} tail", {})).toBeUndefined()
    const unclosed = "${{ ".repeat(80_000)
    const started = performance.now()
    expect(forShell(unclosed, {})).toBe(unclosed)
    expect(forShell(`\${{ matrix.a }}${unclosed}`, { a: "1" })).toBe(`1${unclosed}`)
    // Six seconds before; a bound loose enough for a loaded machine.
    expect(performance.now() - started).toBeLessThan(3000)
  })
})

describe("a comment of a generated YAML file", () => {
  it("holds no character a YAML parser ends a line at, and no control character", () => {
    const text = Yaml.document(
      Yaml.mapping([Yaml.entry("key", "value", ["one\u0085injected: true", "two three four\u0000five\u007fsix"])]),
      ["head\u0085er"]
    )
    expect(text).toBe(
      "# head er\n---\n# one injected: true\n# two three four five six\nkey: value\n"
    )
    expect(parseYaml(text)).toEqual({ key: "value" })
  })
})
