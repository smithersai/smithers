/**
 * A step that uses an action which only sends the job's results out (`resultActions`) is not run by a replay and is
 * kept, as the repository wrote it, for the workflow `apply` writes.
 */

import { describe, expect, it } from "vitest"
import { type Job, resultActions } from "../../src/contract/Inventory.ts"
import { readWorkflow } from "../../src/inventory/GithubActions.ts"

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

  it("leaves the job out when the step reads what a generated workflow's step does not have", () => {
    const env = jobOf(main(`
      - uses: codecov/codecov-action@v5
        with: { files: "\${{ env.REPORT }}" }
`))
    expect(details(env).at(-1)).toBe(
      "uses: main step 2: codecov/codecov-action@v5 reads env, which a step of the workflow apply writes does not have"
    )
    const condition = jobOf(main(`
      - id: t
        run: tox
      - if: steps.t.outcome == 'success' && 'steps.x' != ''
        uses: codecov/codecov-action@v5
`))
    expect(details(condition).at(-1)).toBe(
      "uses: main step 3: codecov/codecov-action@v5 reads steps, which a step of the workflow apply writes does not have"
    )
    expect(
      jobOf(main(`
      - uses: codecov/codecov-action@v5
        with: { name: "\${{ format('{0}-{1}', runner.os, matrix.python) }}", slug: "\${{ github.repository }}" }
`)).kept
    ).toHaveLength(1)
  })

  it("leaves the job out when the step holds a value that is not text or is shaped like a secret", () => {
    expect(
      details(jobOf(main(`
      - uses: codecov/codecov-action@v5
        with: { flags: [a, b] }
`))).at(-1)
    ).toBe("uses: main step 2 gives codecov/codecov-action@v5 a value that is not text")
    expect(
      details(jobOf(main(`
      - uses: codecov/codecov-action@v5
        with: { token: ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa }
`))).at(-1)
    ).toBe("secret-value: main step 2 holds a value shaped like a secret")
  })

  it("names each action with why nothing later in its job depends on it", () => {
    expect(resultActions.map((entry) => entry.action)).toContain("codecov/codecov-action")
    expect(resultActions.every((entry) => entry.why.startsWith("it "))).toBe(true)
  })

  it("is kept when an action that can fail on its report is given no inputs, and not when its inputs are no mapping", () => {
    expect(
      jobOf(main(`
      - uses: mikepenz/action-junit-report@v5
`)).kept
    ).toEqual([{ uses: "mikepenz/action-junit-report@v5" }])
    for (const extra of ["with: just text", "if: [a, b]"]) {
      expect(
        details(jobOf(main(`
      - uses: codecov/codecov-action@v5
        ${extra}
`))).at(-1)
      ).toBe("uses: main step 2 gives codecov/codecov-action@v5 a value that is not text")
    }
  })
})
