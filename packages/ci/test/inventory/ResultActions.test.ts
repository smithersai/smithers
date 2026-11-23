/**
 * A step that uses an action which only sends the job's results out (`resultActions`) is not run by a replay and is
 * kept, as the repository wrote it, for the workflow `apply` writes.
 */

import { describe, expect, it } from "vitest"
import { blockers, type Job, resultActions } from "../../src/contract/Inventory.vibe"
import { readWorkflow } from "../../src/inventory/GithubActions.vibe"

const file = ".github/workflows/ci.yml"

const jobOf = (text: string, id = "ci.yml:main"): Job => {
  const job = readWorkflow(file, text).jobs.find((candidate) => candidate.id === id)
  if (job === undefined) throw new Error(`no job ${id}`)
  return job
}

const details = (job: Job) => job.unsupported.map((entry) => `${entry.feature}: ${entry.detail.slice(file.length + 2)}`)

const main = (steps: string, on = "push") => `
on: ${on}
jobs:
  main:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        python: ["3.11", "3.12"]
    steps:
      - uses: actions/checkout@v4
${steps}
`

describe("a step that only sends the job's results out", () => {
  it("is kept as tkem/cachetools wrote its codecov step, after the step it follows", () => {
    const job = jobOf(main(`
      - run: pip install coverage tox
      - run: tox
      - uses: codecov/codecov-action@303a32d7a59b442fa8d48b6a1cc6825c09c847a5 # v7.1.1
        with:
          name: \${{ matrix.python }}
          token: \${{ secrets.CODECOV_TOKEN }}
`))
    expect(details(job)).toEqual(["host-action: actions/checkout@v4 has no command to run"])
    expect(job.steps.map((step) => step.command)).toEqual(["pip install coverage tox", "tox"])
    // The step receives a secret by name: no step the replay runs does.
    expect(job.steps.flatMap((step) => step.secrets)).toEqual([])
    expect(job.kept).toEqual([{
      uses: "codecov/codecov-action@303a32d7a59b442fa8d48b6a1cc6825c09c847a5",
      after: job.steps[1]?.id,
      with: { name: "${{ matrix.python }}", token: "${{ secrets.CODECOV_TOKEN }}" }
    }])
  })

  it("keeps its id, name, condition, variables, tolerated failure and time limit as written", () => {
    const job = jobOf(main(`
      - id: cov
        name: Upload coverage
        if: always()
        continue-on-error: true
        timeout-minutes: 5
        uses: actions/upload-artifact@v4
        env: { RETENTION: "7" }
        with: { name: "cov-\${{ matrix.python }}", path: coverage.xml, retention-days: 7, overwrite: true }
      - run: echo done
`))
    expect(details(job)).toEqual(["host-action: actions/checkout@v4 has no command to run"])
    expect(job.kept).toEqual([{
      uses: "actions/upload-artifact@v4",
      id: "cov",
      name: "Upload coverage",
      if: "always()",
      with: { name: "cov-${{ matrix.python }}", path: "coverage.xml", "retention-days": "7", overwrite: "true" },
      env: { RETENTION: "7" },
      continueOnError: "true",
      timeoutMinutes: "5"
    }])
    expect(job.steps.map((step) => step.command)).toEqual(["echo done"])
  })

  it("is kept with a condition false for the event a replay stands for: the runner decides it", () => {
    const job = jobOf(main(
      `
      - run: tox
      - if: github.event_name == 'push'
        uses: coverallsapp/github-action@v2
`,
      "pull_request"
    ))
    expect(job.kept?.map((step) => step.if)).toEqual(["github.event_name == 'push'"])
  })

  it("leaves the job out when a later step reads what the action gave or how it ended", () => {
    const outputs = jobOf(main(`
      - id: up
        uses: actions/upload-artifact@v4
        with: { path: dist }
      - run: echo "\${{ steps.up.outputs.artifact-url }}"
`))
    expect(details(outputs)).toContain(
      "expression: main step 3 depends on steps.up.outputs.artifact-url: what actions/upload-artifact@v4 gave: Smithers CI leaves it to your runner"
    )
    const outcome = jobOf(main(`
      - id: up
        uses: codecov/codecov-action@v5
      - if: steps.up.outcome == 'failure'
        run: echo retry
`))
    expect(details(outcome).at(-1)).toBe(
      "condition: main step 3 runs only if steps.up.outcome == 'failure': what codecov/codecov-action@v5 gave: Smithers CI leaves it to your runner"
    )
  })

  it("is an action like any other when it can fail on what it reports", () => {
    expect(
      details(jobOf(main(`
      - uses: dorny/test-reporter@v2
        with: { name: tests, path: report.xml, reporter: java-junit }
`))).at(-1)
    ).toBe("uses: dorny/test-reporter@v2 has no command to run")
    expect(
      details(jobOf(main(`
      - uses: EnricoMi/publish-unit-test-result-action/linux@v2
        with: { files: report.xml, action_fail: true }
`))).at(-1)
    ).toBe("uses: EnricoMi/publish-unit-test-result-action/linux@v2 has no command to run")
    expect(
      jobOf(main(`
      - uses: mikepenz/action-junit-report@v5
        with: { report_paths: report.xml, fail_on_failure: false }
`)).kept
    ).toHaveLength(1)
  })

  it("leaves only the step out when it reads what a generated workflow's step does not have", () => {
    const env = jobOf(main(`
      - uses: codecov/codecov-action@v5
        with: { files: "\${{ env.REPORT }}" }
`))
    const why = "reads env, which a step of the workflow apply writes does not have"
    expect(details(env).at(-1)).toBe(
      `unkept-result: main step 2: codecov/codecov-action@v5 ${why}; the workflow apply writes leaves this step out`
    )
    expect(env.unkept).toEqual([{ uses: "codecov/codecov-action@v5", why }])
    expect(env.kept).toBeUndefined()
    const named = jobOf(main("      - uses: codecov/codecov-action@v5\n        name: Report ${{ env.REPORT }}"))
    expect(named.unkept).toEqual([{ uses: "codecov/codecov-action@v5", why }])
    // The step costs only itself: nothing keeps the job from being replayed.
    expect(blockers(env)).toEqual([])
    const condition = jobOf(main(`
      - id: t
        run: tox
      - if: steps.t.outcome == 'success' && 'steps.x' != ''
        uses: codecov/codecov-action@v5
`))
    expect(details(condition).at(-1)).toBe(
      "unkept-result: main step 3: codecov/codecov-action@v5 reads steps, which a step of the workflow apply writes " +
        "does not have; the workflow apply writes leaves this step out"
    )
    expect(blockers(condition)).toEqual([])
    expect(condition.steps.map((step) => step.command)).toEqual(["tox"])
    expect(
      jobOf(main(`
      - uses: codecov/codecov-action@v5
        with: { name: "\${{ format('{0}-{1}', runner.os, matrix.python) }}", slug: "\${{ github.repository }}" }
`)).kept
    ).toHaveLength(1)
  })

  it("leaves only the step out when it holds a value that is not text or is shaped like a secret", () => {
    const list = jobOf(main(`
      - uses: codecov/codecov-action@v5
        with: { flags: [a, b] }
`))
    expect(details(list).at(-1)).toBe(
      "unkept-result: main step 2: codecov/codecov-action@v5 is given a value that is not text; the workflow apply " +
        "writes leaves this step out"
    )
    expect(blockers(list)).toEqual([])
    const secret = jobOf(main(`
      - uses: codecov/codecov-action@v5
        with: { token: ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa }
`))
    expect(details(secret).at(-1)).toBe(
      "unkept-result: main step 2: codecov/codecov-action@v5 holds a value shaped like a secret; the workflow apply " +
        "writes leaves this step out"
    )
    expect(blockers(secret)).toEqual([])
    // The value is named nowhere in what the inventory holds.
    expect(JSON.stringify(secret)).not.toContain("ghp_")
  })

  it("names each action with why nothing later in its job depends on it", () => {
    expect(resultActions.map((entry) => entry.action)).toContain("codecov/codecov-action")
    expect(resultActions.every((entry) => entry.why.startsWith("it "))).toBe(true)
  })

  it("is kept by default and refuses unreadable failure inputs", () => {
    expect(
      jobOf(main(`
      - uses: mikepenz/action-junit-report@v5
`)).kept
    ).toEqual([{ uses: "mikepenz/action-junit-report@v5" }])
    expect(
      blockers(jobOf(main(`
      - uses: codecov/codecov-action@v5
        with: just text
`)))[0]?.feature
    ).toBe("uses")
    expect(
      details(jobOf(main(`
      - uses: codecov/codecov-action@v5
        if: [a, b]
`))).at(-1)
    ).toContain("is given a value that is not text")
  })
})

describe("an upload whose artifact name the workflow apply writes cannot give", () => {
  // The shape of a job whose upload names its artifact from what an earlier step wrote out: before, the step took
  // the whole job with it ("0 of 49 CI jobs can be reproduced").
  const upload = (name: string) =>
    jobOf(
      `
on:
  push:
  workflow_call:
    inputs:
      label: { type: string, default: checks }
jobs:
  build:
    runs-on: ubuntu-latest
    outputs: { tag: "\${{ steps.stage.outputs.tag }}" }
    steps:
      - id: stage
        run: echo "tag=v1" >> "$GITHUB_OUTPUT"
  checks:
    needs: build
    runs-on: ubuntu-latest
    strategy:
      matrix:
        part: [one, two]
    env: { LABEL: checks }
    steps:
      - uses: actions/checkout@v4
      - id: staging_artifacts
        run: echo "name=report-\${{ matrix.part }}" >> "$GITHUB_OUTPUT"
      - run: make test
      - uses: actions/upload-artifact@v4
        with: { name: "${name}", path: report.xml }
`,
      "ci.yml:checks"
    )

  it.each([
    ["an earlier step's output", "\${{ steps.staging_artifacts.outputs.name }}", "steps"],
    ["another job's output", "\${{ needs.build.outputs.tag }}", "needs"],
    ["the job's variables", "\${{ env.LABEL }}", "env"],
    ["the workflow's inputs", "report-\${{ inputs.label }}", "inputs"]
  ])("is left out alone when its name comes from %s, and the job replays its other steps", (_, name, context) => {
    const job = upload(name)
    expect(blockers(job)).toEqual([])
    expect(job.steps.map((step) => step.command)).toEqual([
      "echo \"name=report-${{ matrix.part }}\" >> \"$GITHUB_OUTPUT\"",
      "make test"
    ])
    expect(job.unkept).toEqual([{
      uses: "actions/upload-artifact@v4",
      why: `reads ${context}, which a step of the workflow apply writes does not have`
    }])
    expect(job.kept).toBeUndefined()
  })

  it("is kept when its name comes from a matrix value, which the workflow apply writes has", () => {
    const job = upload("report-\${{ matrix.part }}")
    expect(blockers(job)).toEqual([])
    expect(job.unkept).toBeUndefined()
    expect(job.kept?.map((step) => step.with?.["name"])).toEqual(["report-${{ matrix.part }}"])
  })
})
