/**
 * A job that ends with a step sending its results out, as tkem/cachetools ends with codecov: the replay runs its
 * other steps and names the step it did not run, and `apply` writes the step as the repository had it.
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"
import type { ReplayReport } from "../../src/contract/ReplayReport.vibe"
import { bin, commit, git, remove, spawn, temporary } from "../cli/repo.ts"

const made: Array<string> = []
afterAll(() => made.forEach(remove))

/** A real replay runs each commit up to three ways; a busy machine takes minutes. */
const replayLimit = 540_000

const smthrs = fileURLToPath(new URL("../../../smithers/bin/smithers.mjs", import.meta.url))

const here = process.platform === "darwin" ? "macos-latest" : "ubuntu-latest"

const workflow = `
on: push
jobs:
  main:
    runs-on: ${here}
    strategy:
      matrix:
        part: [one, two]
    steps:
      - uses: actions/checkout@v4
      - run: sh test.sh \${{ matrix.part }}
      - uses: codecov/codecov-action@v5
        with:
          name: \${{ matrix.part }}
          files: coverage-\${{ matrix.part }}.txt
          token: \${{ secrets.CODECOV_TOKEN }}
      - if: always()
        uses: actions/upload-artifact@v4
        with: { name: "coverage-\${{ matrix.part }}", path: "coverage-*.txt" }
`

const repository = (): string => {
  const root = temporary("result-actions")
  made.push(root)
  git(root, "init", "--quiet", "--initial-branch=main")
  commit(root, "ci", { ".github/workflows/ci.yml": workflow, "test.sh": "echo \"covered $1\" > \"coverage-$1.txt\"\n" })
  return root
}

describe("a job that ends with steps that send its results out", () => {
  it("is replayed without them, and the report names them", async () => {
    const root = repository()
    const outcome = await spawn(bin, ["--commits", "1", "--no-apply-check", "--no-trial", "--json"], root, process.env)
    expect(outcome.code, outcome.stderr).toBe(0)
    const report = JSON.parse(outcome.stdout) as ReplayReport
    expect(report.notReplayed ?? []).toEqual([])
    expect(report.commits[0]?.baseline.counts).toEqual({ hit: 0, ran: 2, failed: 0, skipped: 0 })
    expect(report.commits[0]?.mismatches).toEqual([])
    expect(report.runnerSteps).toEqual([
      { job: "ci.yml:main", action: "codecov/codecov-action@v5", why: "it sends coverage to Codecov" },
      { job: "ci.yml:main", action: "actions/upload-artifact@v4", why: "it stores files for other jobs and for people" }
    ])
    const text = await spawn(bin, ["--commits", "1", "--no-apply-check", "--no-trial"], root, process.env)
    expect(text.stdout).toContain("not run here: your runner runs them, in the workflow apply writes")
    expect(text.stdout).toContain("ci.yml:main  codecov/codecov-action@v5: it sends coverage to Codecov")
  }, replayLimit)

  it("is written by apply as the repository had it, after the steps it follows, once for each variant", async () => {
    const root = repository()
    const applied = await spawn(bin, ["apply"], root, process.env)
    expect(applied.code, applied.stderr).toBe(0)
    const generated = parseYaml(readFileSync(join(root, ".github", "workflows", "smithers-ci.yml"), "utf8")) as {
      readonly jobs: { readonly ci: { readonly steps: ReadonlyArray<Readonly<Record<string, unknown>>> } }
    }
    const steps = generated.jobs.ci.steps
    const last = steps.findIndex((step) => String(step["run"] ?? "").includes("smthrs ci"))
    const after = steps.slice(last + 1)
    // A kept step runs on its job's machine, once the step before it has put the job's files there, and then as
    // the repository's own condition says.
    const restored = (condition: string): unknown =>
      expect.stringMatching(
        new RegExp(
          `^\\$\\{\\{ matrix\\.os == '${here}' && steps\\.smthrs_files_\\d+\\.outcome == 'success' && \\(${
            condition.replace(/[()]/g, "\\$&")
          }\\) \\}\\}$`
        )
      )
    expect(after.filter((step) => step["uses"] === "codecov/codecov-action@v5")).toEqual([
      expect.objectContaining({
        if: restored("success()"),
        with: { name: "one", files: "coverage-one.txt", token: "${{ secrets.CODECOV_TOKEN }}" }
      }),
      expect.objectContaining({
        if: restored("success()"),
        with: { name: "two", files: "coverage-two.txt", token: "${{ secrets.CODECOV_TOKEN }}" }
      })
    ])
    expect(after.filter((step) => step["uses"] === "actions/upload-artifact@v4").map((step) => step["if"])).toEqual([
      restored("always()"),
      restored("always()")
    ])
    // Each kept step follows the step that puts its job's checkout in the workspace.
    expect(after.filter((step) => String(step["name"]).startsWith("Files of ci.yml:main"))).toHaveLength(4)
  }, replayLimit)
  it(
    "finds the files its job left when the workflow apply writes runs, also when every step reused its result",
    async () => {
      const root = repository()
      const applied = await spawn(bin, ["apply"], root, process.env)
      expect(applied.code, applied.stderr).toBe(0)
      commit(root, "apply")
      const steps = (parseYaml(readFileSync(join(root, ".github", "workflows", "smithers-ci.yml"), "utf8")) as {
        readonly jobs: { readonly ci: { readonly steps: ReadonlyArray<Readonly<Record<string, unknown>>> } }
      }).jobs.ci.steps
      // The runner's temporary directory and the workspace an action reads, as GitHub gives them.
      const runnerTemp = temporary("result-actions-runner")
      const workspace = temporary("result-actions-workspace")
      const home = temporary("result-actions-home")
      made.push(runnerTemp, workspace, home)
      // GitHub writes a kept directory as JSON text where the workflow asks it to (`toJSON`), and as it is elsewhere.
      const filled = (text: string): string =>
        text
          .replace(
            /\$\{\{ toJSON\(format\('\{0\}([^']*)', runner\.temp\)\) \}\}/g,
            (_whole, rest: string) => JSON.stringify(`${runnerTemp}${rest}`)
          )
          .replaceAll("${{ runner.temp }}", runnerTemp)
      const build = steps.find((step) => String(step["run"] ?? "").includes("smthrs ci")) as {
        readonly env: Readonly<Record<string, string>>
      }
      const environment = {
        ...process.env,
        HOME: home,
        SMTHRS_MACHINES: filled(build.env["SMTHRS_MACHINES"] as string),
        SMTHRS_KEEP_MACHINES: filled(build.env["SMTHRS_KEEP_MACHINES"] as string)
      }
      const copies = steps.filter((step) => String(step["name"]).startsWith("Files of ci.yml:main"))
      let printed = ""
      const runOnce = (): ReadonlyArray<string> => {
        const ran = spawnSync(process.execPath, [
          smthrs,
          "ci",
          "//...",
          "--jobs",
          "1",
          "--cache-dir",
          join(runnerTemp, "state")
        ], {
          cwd: root,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          env: environment
        })
        expect(ran.status, `${ran.stdout}${ran.stderr}`).toBe(0)
        printed = ran.stdout
        // Each copy step, then what its kept step would read: the coverage its own variant wrote.
        return copies.map((step) => {
          mkdirSync(workspace, { recursive: true })
          // The step is a bash script that reads the kept checkout's place from its own environment.
          const given = Object.fromEntries(
            Object.entries(step["env"] as Readonly<Record<string, string>>).map((
              [name, value]
            ) => [name, filled(value)])
          )
          const copied = spawnSync("bash", ["-c", String(step["run"])], {
            encoding: "utf8",
            env: { ...process.env, ...given, GITHUB_WORKSPACE: workspace }
          })
          expect(copied.status, copied.stderr).toBe(0)
          const part = /\(part (\w+)\)$/.exec(String(step["name"]))?.[1] as string
          return existsSync(join(workspace, `coverage-${part}.txt`))
            ? readFileSync(join(workspace, `coverage-${part}.txt`), "utf8")
            : "none"
        })
      }
      const covered = ["covered one\n", "covered one\n", "covered two\n", "covered two\n"]
      expect(runOnce()).toEqual(covered)
      // Every step is reused now: what each left is put back on its machine before the machine is kept.
      expect(runOnce()).toEqual(covered)
      expect(printed).toMatch(/hit: 2\n\s*ran: 0\n/)
      // The repository's own checkout holds none of it.
      expect(existsSync(join(root, "coverage-one.txt"))).toBe(false)
    },
    replayLimit
  )
})

/** A job whose upload names its artifact from an earlier step's output, which the workflow apply writes does not have. */
const named = `
on: push
jobs:
  checks:
    runs-on: ${here}
    steps:
      - uses: actions/checkout@v4
      - id: staging
        run: echo "name=report" >> "$GITHUB_OUTPUT"
      - run: sh test.sh one
      - uses: actions/upload-artifact@v4
        with:
          name: \${{ steps.staging.outputs.name }}
          path: coverage-one.txt
`

describe("a job whose result step the workflow apply writes cannot keep", () => {
  it("is replayed with its other steps, and only that step is left out, named in the report and by apply", async () => {
    const root = temporary("result-unkept")
    made.push(root)
    git(root, "init", "--quiet", "--initial-branch=main")
    commit(root, "ci", { ".github/workflows/ci.yml": named, "test.sh": "echo \"covered $1\" > \"coverage-$1.txt\"\n" })
    const outcome = await spawn(bin, ["--commits", "1", "--no-apply-check", "--no-trial", "--json"], root, process.env)
    expect(outcome.code, outcome.stderr).toBe(0)
    const report = JSON.parse(outcome.stdout) as ReplayReport
    expect(report.notReplayed ?? []).toEqual([])
    expect(report.commits[0]?.baseline.counts).toEqual({ hit: 0, ran: 2, failed: 0, skipped: 0 })
    const why = "reads steps, which a step of the workflow apply writes does not have"
    expect(report.stepsLeftOut).toEqual([{ job: "ci.yml:checks", action: "actions/upload-artifact@v4", why }])
    expect(report.runnerSteps).toBeUndefined()
    const applied = await spawn(bin, ["apply"], root, process.env)
    expect(applied.code, applied.stderr).toBe(0)
    const notes = readFileSync(join(root, ".smithers", "ci", "NOT-REPRODUCED.txt"), "utf8")
    expect(notes).toContain(
      `- ci.yml:checks: unkept-result: .github/workflows/ci.yml: checks step 4: actions/upload-artifact@v4 ${why}; ` +
        "the workflow apply writes leaves this step out"
    )
    const generated = readFileSync(join(root, ".github", "workflows", "smithers-ci.yml"), "utf8")
    expect(generated).not.toContain("upload-artifact")
  }, replayLimit)
})
