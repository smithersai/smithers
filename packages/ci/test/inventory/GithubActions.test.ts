import { describe, expect, it } from "vitest"
import type { Job } from "../../src/contract/Inventory.ts"
import { readWorkflow } from "../../src/inventory/GithubActions.ts"

const file = ".github/workflows/ci.yml"
const read = (text: string) => readWorkflow(file, text)

const jobOf = (text: string, id = "ci.yml:test"): Job => {
  const job = read(text).jobs.find((candidate) => candidate.id === id)
  if (job === undefined) throw new Error(`no job ${id}`)
  return job
}

/** A workflow with one job `test` holding these steps, written as YAML list items. */
const withSteps = (steps: string, jobExtra = "") => `
on: push
jobs:
  test:
    runs-on: ubuntu-latest
${jobExtra}
    steps:
${steps}
`

const features = (job: Job) => job.unsupported.map((entry) => entry.feature)
const details = (job: Job) => job.unsupported.map((entry) => entry.detail)

describe("readWorkflow jobs", () => {
  it("reads a job's steps, needs, triggers, runner and names", () => {
    const { jobs } = read(`
name: CI
on: [push, pull_request]
jobs:
  build:
    name: Build it
    runs-on: ubuntu-latest
    steps:
      - name: Install
        run: bun install --frozen-lockfile
      - run: |
          bun run build
          bun run check
  test:
    needs: build
    runs-on: [self-hosted, linux]
    steps:
      - run: bun test
  all:
    needs: [build, test]
    runs-on: ubuntu-latest
    steps: []
`)
    expect(jobs.map((job) => job.id)).toEqual(["ci.yml:build", "ci.yml:test", "ci.yml:all"])
    expect(jobs[0]).toEqual({
      id: "ci.yml:build",
      source: "github-actions",
      file,
      name: "Build it",
      needs: [],
      triggers: ["push", "pull_request"],
      matrix: [],
      runsOn: "ubuntu-latest",
      steps: [
        {
          id: "ci.yml:build:1",
          name: "Install",
          command: "bun install --frozen-lockfile",
          cwd: "",
          env: {},
          secrets: []
        },
        { id: "ci.yml:build:2", command: "bun run build\nbun run check", cwd: "", env: {}, secrets: [] }
      ],
      unsupported: []
    })
    expect(jobs[1]?.needs).toEqual(["ci.yml:build"])
    expect(jobs[1]?.runsOn).toBe("self-hosted,linux")
    expect(jobs[2]?.needs).toEqual(["ci.yml:build", "ci.yml:test"])
  })

  it("reads each form of trigger and reports event filters", () => {
    expect(jobOf("on: push\njobs: { test: { steps: [] } }").triggers).toEqual(["push"])
    expect(jobOf("jobs: { test: { steps: [] } }").triggers).toEqual([])
    const filtered = jobOf(`
on:
  workflow_dispatch:
  schedule:
    - cron: "0 0 * * *"
  push:
    branches: [main]
    paths-ignore: [docs/**]
  pull_request:
    types: [opened]
jobs: { test: { steps: [] } }
`)
    expect(filtered.triggers).toEqual(["workflow_dispatch", "schedule", "push", "pull_request"])
    expect(filtered.unsupported).toEqual([
      { feature: "trigger-filter", detail: `${file}: push runs only for matching branches, paths-ignore` },
      { feature: "trigger-filter", detail: `${file}: pull_request runs only for matching types` }
    ])
  })

  it("reports what a job needs that a command cannot reproduce", () => {
    const job = jobOf(`
on: push
jobs:
  test:
    if: github.ref == 'refs/heads/main'
    services: { db: { image: postgres } }
    container: node:22
    environment: production
    continue-on-error: true
    runs-on: { group: large }
    needs: { bad: true }
    steps: []
`)
    expect(features(job).sort()).toEqual([
      "condition",
      "container",
      "continue-on-error",
      "environment",
      "malformed-job",
      "runner",
      "services"
    ])
    expect(job.runsOn).toBeUndefined()
    expect(job.needs).toEqual([])
    expect(details(job)).toContain(`${file}: test runs only if github.ref == 'refs/heads/main'`)
  })

  it("reports a reusable workflow, a job with no steps and a job that is not a mapping", () => {
    const { jobs } = read(`
on: push
jobs:
  shared:
    uses: ./.github/workflows/other.yml
  empty:
    runs-on: ubuntu-latest
  odd: nonsense
`)
    expect(jobs[0]?.unsupported[0]).toEqual({
      feature: "uses",
      detail: `${file}: ./.github/workflows/other.yml is a reusable workflow; its jobs were not read`
    })
    expect(jobs[0]?.runsOn).toBeUndefined()
    expect(features(jobs[1] as Job)).toEqual(["malformed-job"])
    expect(jobs[2]).toMatchObject({ id: "ci.yml:odd", name: "odd", triggers: ["push"], steps: [] })
    expect(features(jobs[2] as Job)).toEqual(["malformed-job"])
  })

  it("reports a runner chosen by an expression, keeping a matrix runner as written", () => {
    const computed = jobOf(`
on: push
jobs:
  test:
    runs-on: \${{ fromJSON(vars.RUNNERS) }}
    steps: []
`)
    expect(computed.runsOn).toBe("${{ fromJSON(vars.RUNNERS) }}")
    expect(features(computed)).toEqual(["runner"])
    const matrix = jobOf(`
on: push
jobs:
  test:
    runs-on: \${{ matrix.os }}
    strategy: { matrix: { os: [ubuntu-latest, macos-latest] } }
    steps: []
`)
    expect(matrix.runsOn).toBe("${{ matrix.os }}")
    expect(matrix.unsupported).toEqual([])
    expect(matrix.matrix).toEqual([{ os: "ubuntu-latest" }, { os: "macos-latest" }])
  })
})

describe("readWorkflow steps", () => {
  it("records a uses step as unsupported and adds no command", () => {
    const job = jobOf(withSteps(`
      - uses: actions/checkout@v4
      - run: bun test
      - uses: codecov/codecov-action@v5
        with: { token: "\${{ secrets.CODECOV_TOKEN }}" }
`))
    expect(job.steps.map((step) => [step.id, step.command])).toEqual([["ci.yml:test:1", "bun test"]])
    expect(job.unsupported).toEqual([
      { feature: "host-action", detail: `${file}: actions/checkout@v4 has no command to run` },
      { feature: "uses", detail: `${file}: codecov/codecov-action@v5 has no command to run` }
    ])
  })

  it("reports steps it cannot read", () => {
    const job = jobOf(withSteps(`
      - just text
      - name: Nothing
      - run: [not, text]
      - run: "   "
`))
    expect(features(job)).toEqual(["malformed-step", "malformed-step", "malformed-step", "empty-command"])
    expect(job.steps).toEqual([])
    expect(details(job)[1]).toBe(`${file}: test step 2 (Nothing) has neither run nor uses`)
  })

  it("reports a step condition and a step allowed to fail, and keeps the command", () => {
    const job = jobOf(withSteps(`
      - run: bun test
        if: always()
        continue-on-error: true
`))
    expect(job.steps).toHaveLength(1)
    expect(features(job)).toEqual(["condition", "continue-on-error"])
  })

  it("merges env from workflow, job and step, the nearest winning", () => {
    const { jobs } = read(`
on: push
env: { LEVEL: workflow, ONLY_WORKFLOW: "1", COUNT: 3, FLAG: true, EMPTY: null }
jobs:
  test:
    runs-on: ubuntu-latest
    env: { LEVEL: job }
    steps:
      - run: echo a
        env: { LEVEL: step, FROM_ENV: "\${{ env.ONLY_WORKFLOW }}-x" }
      - run: echo \${{ env.LEVEL }}
`)
    const [first, second] = jobs[0]?.steps ?? []
    expect(first?.env).toEqual({
      LEVEL: "step",
      ONLY_WORKFLOW: "1",
      COUNT: "3",
      FLAG: "true",
      EMPTY: "",
      FROM_ENV: "1-x"
    })
    expect(second?.command).toBe("echo job")
  })

  it("reports env it cannot read and leaves those variables out", () => {
    const job = jobOf(withSteps(`
      - run: echo \${{ env.SHA }}
        env:
          SHA: \${{ github.sha }}
          LIST: [a]
      - run: echo ok
        env: \${{ fromJSON(vars.ENV) }}
`))
    expect(job.steps.map((step) => step.command)).toEqual(["echo ok"])
    expect(job.steps[0]?.env).toEqual({})
    expect(features(job)).toEqual(["expression", "malformed-env", "expression", "expression"])
    expect(details(job)[0]).toContain("sets SHA from github.sha")
  })

  it("keeps matrix variables as written and resolves nothing else it cannot know", () => {
    const job = jobOf(`
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        shard: [1, 2]
        node: [{ version: 20 }]
    steps:
      - run: bun test --shard=\${{matrix.shard}}/2 --node=\${{ matrix.node.version }}
        env: { SHARD: "\${{ matrix.shard }}" }
        working-directory: packages/\${{ matrix.shard }}
      - run: echo \${{ matrix.missing }}
      - run: echo \${{ github.sha }} \${{ inputs.name }}
`)
    expect(job.matrix).toEqual([
      { shard: "1", "node.version": "20" },
      { shard: "2", "node.version": "20" }
    ])
    expect(job.steps).toHaveLength(1)
    expect(job.steps[0]).toMatchObject({
      command: "bun test --shard=${{ matrix.shard }}/2 --node=${{ matrix.node.version }}",
      cwd: "packages/${{ matrix.shard }}",
      env: { SHARD: "${{ matrix.shard }}" }
    })
    expect(details(job)).toEqual([
      `${file}: test step 2 depends on matrix.missing`,
      `${file}: test step 3 depends on github.sha, inputs.name`
    ])
  })

  it("reports a matrix it cannot read", () => {
    const job = jobOf(`
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy: { matrix: "\${{ fromJSON(needs.a.outputs.m) }}" }
    steps:
      - run: echo \${{ matrix.x }}
`)
    expect(job.matrix).toEqual([])
    expect(job.steps).toEqual([])
    expect(features(job)).toEqual(["matrix", "expression"])
  })

  it("records secrets by name only", () => {
    const job = jobOf(`
on: push
env: { WORKFLOW_TOKEN: "\${{ secrets.WORKFLOW_TOKEN }}" }
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: bun publish
        env:
          NPM_TOKEN: \${{ secrets.NPM_TOKEN }}
          GH_TOKEN: \${{ github.token }}
          MIXED: prefix-\${{ secrets.OTHER }}
      - run: curl -H "\${{ secrets.INLINE }}" example.test
`)
    expect(job.steps).toHaveLength(1)
    expect(job.steps[0]?.secrets).toEqual(["OTHER", "WORKFLOW_TOKEN", "NPM_TOKEN", "GITHUB_TOKEN"])
    expect(job.steps[0]?.secretEnv).toEqual({
      WORKFLOW_TOKEN: "WORKFLOW_TOKEN",
      NPM_TOKEN: "NPM_TOKEN",
      GH_TOKEN: "GITHUB_TOKEN"
    })
    expect(job.steps[0]?.env).toEqual({})
    expect(details(job)).toEqual([
      `${file}: test step 1 builds MIXED from secret OTHER`,
      `${file}: test step 2 depends on secret INLINE`
    ])
  })

  it("keeps literal credentials out of steps", () => {
    const value = `ghp_${"a".repeat(30)}`
    const job = jobOf(withSteps(`
      - run: curl -u ${value} example.test
      - run: echo ok
        env: { API_KEY: plain-text, LOOKS_FINE: ${value}, READ_LATER: "$OTHER_TOKEN", API_TOKEN: "$ecret1" }
`))
    expect(job.steps.map((step) => step.command)).toEqual(["echo ok"])
    expect(job.steps[0]?.secrets).toEqual(["API_KEY", "LOOKS_FINE", "API_TOKEN"])
    expect(job.steps[0]?.env).toEqual({ READ_LATER: "$OTHER_TOKEN" })
    expect(JSON.stringify(job)).not.toContain("$ecret1")
    expect(JSON.stringify(job)).not.toContain(value)
    expect(JSON.stringify(job)).not.toContain("plain-text")
  })

  it("reads working directories", () => {
    const job = jobOf(`
on: push
defaults: { run: { working-directory: from-workflow } }
env: { DIR: packages/a }
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: a
      - run: b
        working-directory: ./packages//x/../y/
      - run: c
        working-directory: \${{ env.DIR }}
      - run: d
        working-directory: \${{ github.workspace }}/tools
      - run: e
        working-directory: .
      - run: f
        working-directory: /tmp
      - run: g
        working-directory: ../outside
      - run: h
        working-directory: \${{ steps.root.outputs.dir }}
      - run: i
        working-directory: \${{ secrets.DIR }}
`)
    expect(job.steps.map((step) => [step.command, step.cwd])).toEqual([
      ["a", "from-workflow"],
      ["b", "packages/y"],
      ["c", "packages/a"],
      ["d", "tools"],
      ["e", ""]
    ])
    expect(details(job)).toEqual([
      `${file}: test step 6: its directory /tmp is outside the repository`,
      `${file}: test step 7: its directory ../outside is outside the repository`,
      `${file}: test step 8: its directory comes from steps.root.outputs.dir`,
      `${file}: test step 9: its directory comes from DIR`
    ])
  })

  it("lets job defaults override workflow defaults", () => {
    const job = jobOf(`
on: push
defaults: { run: { working-directory: workflow, shell: sh } }
jobs:
  test:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: job } }
    steps:
      - run: a
`)
    expect(job.steps[0]).toMatchObject({ cwd: "job", command: "sh -e -c a" })
    const shellOnly = jobOf(`
on: push
defaults: { run: { working-directory: workflow } }
jobs:
  test:
    runs-on: ubuntu-latest
    defaults: { run: { shell: sh } }
    steps:
      - run: a
`)
    expect(shellOnly.steps[0]).toMatchObject({ cwd: "workflow", command: "sh -e -c a" })
  })

  it("keeps the shell a step names in its command", () => {
    const job = jobOf(withSteps(`
      - run: echo "it's"
        shell: bash
      - run: echo two
        shell: bash -e {0}
      - run: print("no")
        shell: python
      - run: echo three
        shell: 7
`))
    expect(job.steps.map((step) => step.command)).toEqual([
      `bash --noprofile --norc -eo pipefail -c 'echo "it'\\''s"'`,
      "bash -e -c 'echo two'"
    ])
    expect(details(job)).toEqual([
      `${file}: test step 3 runs in python`,
      `${file}: test step 4 names its shell with a value that is not text`
    ])
  })

  it("does not read PowerShell steps as shell commands", () => {
    const only = jobOf(`
on: push
jobs:
  test:
    runs-on: windows-latest
    steps:
      - run: Get-ChildItem
      - run: ls
        shell: bash
`)
    expect(only.steps).toHaveLength(1)
    expect(details(only)).toEqual([`${file}: test step 1 runs in PowerShell on Windows`])
    const some = jobOf(`
on: push
jobs:
  test:
    runs-on: \${{ matrix.os }}
    strategy: { matrix: { os: [ubuntu-latest, windows-latest] } }
    steps:
      - run: ls
`)
    expect(some.steps).toHaveLength(1)
    expect(details(some)).toEqual([`${file}: some variants of test run in PowerShell on Windows`])
    const partial = jobOf(`
on: push
jobs:
  test:
    runs-on: \${{ matrix.os }}
    strategy: { matrix: { include: [{ os: ubuntu-latest }, { extra: a }] } }
    steps:
      - run: ls
`)
    expect(partial.unsupported).toEqual([])
  })

  it("reports commands that read the runner's own variables", () => {
    const job = jobOf(withSteps(`
      - run: echo x >> "$GITHUB_OUTPUT"; echo "$RUNNER_TEMP $GITHUB_OUTPUT"
`))
    expect(job.steps).toHaveLength(1)
    expect(details(job)).toEqual([`${file}: test step 1 reads GITHUB_OUTPUT, RUNNER_TEMP`])
  })
})

describe("readWorkflow exactness", () => {
  it("never pastes a literal secret into a command or another variable", () => {
    const job = jobOf(`
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    env: { API_KEY: hunter2 }
    steps:
      - run: curl -u \${{ env.API_KEY }} x.test
      - run: echo ok
        env: { COPY: "\${{ env.API_KEY }}" }
`)
    expect(job.steps.map((step) => step.command)).toEqual(["echo ok"])
    expect(job.steps[0]?.env).toEqual({})
    expect(job.steps[0]?.secretEnv).toEqual({ COPY: "API_KEY", API_KEY: "API_KEY" })
    expect(details(job)[0]).toBe(`${file}: test step 1 depends on secret API_KEY`)
    expect(JSON.stringify(job)).not.toContain("hunter2")
  })

  it("treats a dollar sign in a secret-named value as part of the value", () => {
    const job = jobOf(withSteps(`
      - run: go
        env: { API_TOKEN: "pa$$word1" }
`))
    expect(job.steps[0]).toMatchObject({ env: {}, secretEnv: { API_TOKEN: "API_TOKEN" } })
  })

  it("forgets a secret when a nearer env block sets the same variable", () => {
    const job = jobOf(`
on: push
env: { DEPLOY: "\${{ secrets.DEPLOY }}" }
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: go
        env: { DEPLOY: "off" }
`)
    expect(job.steps[0]).toMatchObject({ env: { DEPLOY: "off" }, secrets: [] })
    expect(job.steps[0]?.secretEnv).toBeUndefined()
  })

  it("gives the workflow's and a job's env no env context, as GitHub does", () => {
    const job = jobOf(`
on: push
env: { A: x, B: "\${{ env.A }}" }
jobs:
  test:
    runs-on: ubuntu-latest
    env: { C: "\${{ env.A }}" }
    steps:
      - run: go
`)
    expect(job.steps[0]?.env).toEqual({ A: "x" })
    expect(details(job).sort()).toEqual([
      `${file}: test sets C from env.A`,
      `${file}: the workflow sets B from env.A`
    ])
  })

  it("makes a matrix key a variant lacks empty, as GitHub reads it", () => {
    const job = jobOf(`
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy: { matrix: { n: [1, 2], include: [{ n: 1, extra: yes1 }, { n: 1, unused: z }] } }
    steps:
      - run: t --flag=\${{ matrix.extra }}
`)
    expect(job.matrix).toEqual([{ n: "1", extra: "yes1", unused: "z" }, { n: "2", extra: "" }])
  })

  it.each([
    ["windows-\${{ matrix.v }}", "{ v: [2022, 2025] }"],
    ["\${{ matrix.os }}", "{ os: [windows-2022, windows-2025] }"],
    ["\${{ matrix.pool }}-\${{ matrix.os }}", "{ pool: [a], os: [windows] }"]
  ])("reads %s with every variant on Windows as PowerShell", (runsOn, matrix) => {
    const job = jobOf(`
on: push
jobs:
  test:
    runs-on: ${runsOn}
    strategy: { matrix: ${matrix} }
    steps:
      - run: dir
`)
    expect(job.steps).toEqual([])
    expect(features(job)).toEqual(["shell"])
  })

  it.each([
    ["the job", "    env: { API_KEY: \"\${{ matrix.k }}\" }\n    steps:\n      - run: go"],
    ["a step", "    steps:\n      - run: go\n        env: { API_KEY: \"\${{ matrix.k }}\" }"]
  ])("keeps a matrix value out of the inventory when %s gives it to a secret-named variable", (_where, rest) => {
    const job = jobOf(`
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy: { matrix: { k: [hunter2] } }
${rest}
`)
    expect(job.matrix).toEqual([])
    expect(features(job)).toContain("matrix")
    expect(JSON.stringify(job)).not.toContain("hunter2")
  })

  it("refuses a matrix value that would end the quoting around a script", () => {
    const job = jobOf(`
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy: { matrix: { a: ["--grep 'x y'"] } }
    steps:
      - run: t \${{ matrix.a }}
        shell: bash
      - run: t \${{ matrix.a }}
`)
    expect(job.steps.map((step) => step.command)).toEqual(["t \${{ matrix.a }}"])
    expect(details(job)).toEqual([`${file}: test step 1 puts a matrix value holding a quote into its script`])
  })

  it("reads a numeric directory and reports one that is not a scalar", () => {
    const job = jobOf(withSteps(`
      - run: a
        working-directory: 2024
      - run: b
        working-directory: [x]
`))
    expect(job.steps.map((step) => step.cwd)).toEqual(["2024"])
    expect(details(job)).toEqual([`${file}: test step 2 has a directory that is not text`])
  })

  it("checks a matrix directory against every variant", () => {
    const inside = jobOf(`
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy: { matrix: { d: [a/b] } }
    steps:
      - run: a
        working-directory: ./\${{ matrix.d }}/../
`)
    expect(inside.steps[0]?.cwd).toBe("\${{ matrix.d }}/..")
    const outside = jobOf(`
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy: { matrix: { d: [a, /opt/x] } }
    steps:
      - run: a
        working-directory: \${{ matrix.d }}
`)
    expect(outside.steps).toEqual([])
    expect(features(outside)).toEqual(["working-directory"])
  })

  it("reports a strategy computed when the workflow runs", () => {
    const job = jobOf(`
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy: \${{ fromJSON(vars.S) }}
    steps: []
`)
    expect(features(job)).toEqual(["matrix"])
  })
})

describe("readWorkflow toolchains", () => {
  it("records the tools setup actions pin, by version when it is known", () => {
    const { toolchains } = read(`
on: push
env: { BUN: 1.3.0 }
jobs:
  test:
    runs-on: ubuntu-latest
    strategy: { matrix: { go: ["1.22"] } }
    steps:
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: "\${{ env.BUN }}" }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - uses: actions/setup-go@v5
        with: { go-version: "\${{ matrix.go }}" }
      - uses: pnpm/action-setup@v4
      - uses: mlugg/setup-zig@v2
        with: { version: "" }
      - uses: actions/setup-python@v5
        with: { python-version: [a] }
      - uses: actions/checkout@v4
`)
    expect(toolchains).toEqual([
      { name: "bun", source: file, version: "1.3.0" },
      { name: "node", source: file, version: "22" },
      { name: "go", source: file },
      { name: "pnpm", source: file },
      { name: "zig", source: file },
      { name: "python", source: file }
    ])
  })
})

describe("readWorkflow malformed files", () => {
  const problem = (text: string) => {
    const { jobs, toolchains, unsupported } = readWorkflow(".github/workflows/bad.yaml", text)
    expect(toolchains).toEqual([])
    expect(jobs).toEqual([])
    return unsupported[0]
  }

  it("reports invalid YAML with its line", () => {
    expect(problem("on: push\njobs: [unclosed")).toMatchObject({
      feature: "malformed-file",
      detail: expect.stringMatching(/^\.github\/workflows\/bad\.yaml: \w+ at line \d+$/)
    })
  })

  it("reports YAML whose aliases cannot be expanded", () => {
    const aliases = Array.from({ length: 200 }, () => "*a").join(", ")
    expect(problem(`x: &a [1]\ny: [${aliases}]\njobs: {}`)?.detail).toContain("its aliases cannot be expanded")
  })

  it("reports a file with no jobs", () => {
    expect(problem("just a string")?.detail).toContain("it has no jobs mapping")
    expect(problem("on: push\njobs: []")?.detail).toContain("it has no jobs mapping")
  })

  it("copies problems of the workflow's own env onto every job", () => {
    const { jobs } = read(`
on: push
env: { SHA: "\${{ github.sha }}" }
jobs:
  a: { runs-on: x, steps: [] }
  b: { runs-on: x, steps: [] }
`)
    expect(jobs.map((job) => details(job))).toEqual([
      [`${file}: the workflow sets SHA from github.sha`],
      [`${file}: the workflow sets SHA from github.sha`]
    ])
  })
})
