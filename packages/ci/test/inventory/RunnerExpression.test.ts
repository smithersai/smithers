/**
 * A runner picked by an expression over the matrix (`runs-on: ${{ matrix.os || 'ubuntu-latest' }}`) is worked out
 * for each variant with the values the workflow file gives, by the evaluator `if:` and `env` use.
 */

import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import { ci, type Job, runnerOf, unknownRunner } from "../../src/contract/Inventory.vibe"
import { path as targetMapPath, type TargetMap } from "../../src/contract/TargetMap.vibe"
import { files } from "../../src/generate/index.vibe"
import { notesPath } from "../../src/generate/Render.ts"
import { readWorkflow } from "../../src/inventory/GithubActions.vibe"
import { onMachine } from "../../src/inventory/Tools.ts"
import { replayable } from "../../src/replay/Summary.vibe"

const file = ".github/workflows/ci.yml"

const jobsOf = (text: string): ReadonlyArray<Job> => readWorkflow(file, text).jobs

const jobOf = (text: string, id = "ci.yml:tests"): Job => {
  const job = jobsOf(text).find((candidate) => candidate.id === id)
  if (job === undefined) throw new Error(`no job ${id}`)
  return job
}

const runners = (job: Job): ReadonlyArray<string | undefined> => job.matrix.map((variant) => runnerOf(job, variant))
const details = (job: Job) => job.unsupported.map((entry) => `${entry.feature}: ${entry.detail}`)

const tests = (runsOn: string, include: string, steps = "[{ run: echo ok }]") => `
on: push
jobs:
  tests:
    runs-on: ${runsOn}
    strategy:
      matrix:
        include:
${include}
    steps: ${steps}
`

describe("a runner picked by an expression over the matrix", () => {
  it("is worked out for each variant, as pallets/itsdangerous picks it", () => {
    const job = jobOf(tests(
      "${{ matrix.os || 'ubuntu-latest' }}",
      [
        "          - {python: '3.13'}",
        "          - {name: Windows, python: '3.13', os: windows-latest}",
        "          - {name: Mac, python: '3.13', os: macos-latest}",
        "          - {name: PyPy, python: 'pypy-3.11', tox: pypy311}"
      ].join("\n")
    ))
    expect(job.unsupported).toEqual([])
    expect(job.runsOn).toBe("${{ matrix.os || 'ubuntu-latest' }}")
    expect(runners(job)).toEqual(["ubuntu-latest", "windows-latest", "macos-latest", "ubuntu-latest"])
    // Each variant runs where its runner is: the Linux ones here, the others nowhere a Linux machine reaches.
    const linux = onMachine(
      { version: 1, repository: "r", commit: "c", toolchains: [], jobs: [job] },
      "linux",
      new Map()
    )
    expect(linux.jobs[0]?.unsupported).toEqual([])
    const windows = onMachine(
      { version: 1, repository: "r", commit: "c", toolchains: [], jobs: [job] },
      "win32",
      new Map()
    )
    expect(windows.jobs[0]?.unsupported).toEqual([])
  })

  it("reads `&&`, `==`, `!=`, `format` and `fromJSON` of a literal, with numbers and booleans as written", () => {
    const job = jobOf(tests(
      "${{ matrix.big == true && format('{0}-{1}', 'ubuntu', matrix.version) || matrix.arch != 'arm' && fromJSON('[\"ubuntu-24.04\", \"x64\"]') || 'ubuntu-24.04-arm' }}",
      [
        "          - {big: true, version: 22.04, arch: x64}",
        "          - {big: false, version: 22.04, arch: x64}",
        "          - {big: false, version: 22.04, arch: arm}"
      ].join("\n")
    ))
    expect(job.unsupported).toEqual([])
    expect(runners(job)).toEqual(["ubuntu-22.04", "ubuntu-24.04,x64", "ubuntu-24.04-arm"])
  })

  it("reads a nested matrix value and a label in a list", () => {
    const job = jobOf(tests(
      "[self-hosted, \"${{ matrix.platform.os || 'linux' }}\"]",
      [
        "          - {name: a, platform: {os: gpu}}",
        "          - {name: b, platform: {arch: x64}}"
      ].join("\n")
    ))
    expect(runners(job)).toEqual(["self-hosted,gpu", "self-hosted,linux"])
  })

  it("keeps a runner the file does not give as its expression, and leaves only that variant out", () => {
    const job = jobOf(tests(
      "${{ matrix.os || (matrix.pool && vars.POOL) || 'ubuntu-latest' }}",
      [
        "          - {name: plain}",
        "          - {name: pooled, pool: big}"
      ].join("\n")
    ))
    expect(job.unsupported).toEqual([])
    const [plain, pooled] = runners(job)
    expect(plain).toBe("ubuntu-latest")
    expect(pooled).toBe("${{ matrix.os || (matrix.pool && vars.POOL) || 'ubuntu-latest' }}")
    expect([unknownRunner(plain), unknownRunner(pooled), unknownRunner(undefined)]).toEqual([false, true, false])
    // On a machine, the variant with no known runner is not one that runs here.
    const read = onMachine(
      { version: 1, repository: "r", commit: "c", toolchains: [], jobs: [job] },
      "linux",
      new Map()
    )
    expect(read.jobs[0]?.unsupported).toEqual([])
  })

  it("leaves the job out, naming the expression, when no variant's runner is known", () => {
    const job = jobOf(tests(
      "${{ matrix.os || needs.pick.outputs.runner }}",
      "          - {name: a}\n          - {name: b}"
    ))
    expect(job.runners).toBeUndefined()
    expect(details(job)).toEqual([
      `runner: ${file}: tests picks its runner from matrix.os || needs.pick.outputs.runner`
    ])
  })

  it("reads a repository variable as unknown, also where no matrix is", () => {
    const job = jobOf(`
on: push
jobs:
  tests:
    runs-on: \${{ vars.RUNNER || 'ubuntu-latest' }}
    steps: [{ run: echo ok }]
`)
    expect(details(job)).toEqual([`runner: ${file}: tests picks its runner from vars.RUNNER || 'ubuntu-latest'`])
  })

  it("leaves a runner each variant fills in by name as it was", () => {
    const job = jobOf(tests("${{ matrix.os }}", "          - {os: ubuntu-latest}\n          - {os: macos-latest}"))
    expect(job.runners).toBeUndefined()
    expect(runners(job)).toEqual(["ubuntu-latest", "macos-latest"])
    // A variant that is not the job's own is filled in by name.
    expect(runnerOf(job, { os: "ubuntu-22.04" })).toBe("ubuntu-22.04")
    const { runsOn: _runsOn, ...named } = job
    expect(runnerOf(named, {})).toBeUndefined()
  })

  it("reads the PowerShell default of a job whose every variant is on Windows", () => {
    const job = jobOf(tests(
      "${{ matrix.os || 'windows-latest' }}",
      "          - {os: windows-2022}\n          - {name: b}",
      "[{ run: echo ok }]"
    ))
    expect(runners(job)).toEqual(["windows-2022", "windows-latest"])
    expect(details(job)).toEqual([`shell: ${file}: tests step 1 runs in PowerShell on Windows`])
  })

  it("reads a runner picked by group, and a matrix value whose type differs between variants, as GitHub does", () => {
    const grouped = jobOf(tests("{ group: big }", "          - {os: a}"))
    expect(grouped.runsOn).toBeUndefined()
    expect(details(grouped)).toEqual([`runner: ${file}: tests picks its runner by group`])
    const mixed = jobOf(tests(
      "${{ matrix.size == 2 && 'ubuntu-24.04' || 'ubuntu-22.04' }}",
      "          - {size: 2}\n          - {size: big}"
    ))
    expect(runners(mixed)).toEqual(["ubuntu-24.04", "ubuntu-22.04"])
  })
})

describe("a variant whose runner the workflow file does not give", () => {
  const read = jobOf(tests(
    "${{ matrix.os || (matrix.pool && vars.POOL) || 'ubuntu-latest' }}",
    "          - {name: plain}\n          - {name: pooled, pool: big}"
  ))
  const all = ci({ version: 1, repository: "r", commit: "c", toolchains: [], jobs: [read] })

  it("is filled in by name when it is not one of the job's variants", () => {
    expect(runnerOf(read, { name: "other" })).toBe("${{ matrix.os || (matrix.pool && vars.POOL) || 'ubuntu-latest' }}")
  })

  it("is left out of the replay with the expression, and the other variant is replayed", () => {
    const labels = read.matrix.map((variant) => ({
      job: read.id,
      step: read.steps[0]?.id as string,
      variant,
      label: `//:t-${variant["name"]}`
    }))
    const found = replayable(all, { version: 1, targets: labels }, "linux")
    expect(found.units.map((unit) => unit.steps.map((each) => each.label))).toEqual([["//:t-plain"]])
    expect(found.left).toEqual([{
      job: read.id,
      reasons: [{
        feature: "runner",
        detail:
          `${read.id} (name=pooled, pool=big) picks its runner from \${{ matrix.os || (matrix.pool && vars.POOL) || 'ubuntu-latest' }}`
      }]
    }])
  })

  it("is named in the notes and gets no target from apply", () => {
    const generated = Effect.runSync(files(all))
    const notes = generated.find((entry) => entry.path === notesPath)?.content ?? ""
    expect(notes).toContain(
      `${read.id}: a variant picks its runner from \${{ matrix.os || (matrix.pool && vars.POOL) || 'ubuntu-latest' }}, which the workflow file does not give.`
    )
    const map = JSON.parse(generated.find((entry) => entry.path === targetMapPath)?.content ?? "{}") as TargetMap
    expect(map.targets.map((target) => target.variant)).toEqual([{ name: "plain" }])
  })
})
