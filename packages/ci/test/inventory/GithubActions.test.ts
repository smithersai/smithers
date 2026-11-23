import { describe, expect, it } from "vitest"
import type { Job } from "../../src/contract/Inventory.vibe"
import { assemble } from "../../src/inventory/Draft.vibe"
import { readWorkflow } from "../../src/inventory/GithubActions.vibe"

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
          secrets: [],
          runner: expect.any(String)
        },
        {
          id: "ci.yml:build:2",
          command: "bun run build\nbun run check",
          cwd: "",
          env: {},
          secrets: [],
          runner: expect.any(String)
        }
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

  it("reports a workflow that only a pushed tag starts as a release, not as a filter", () => {
    const featuresFor = (on: string): ReadonlyArray<string> =>
      features(jobOf(`on:\n${on}\njobs: { test: { steps: [] } }`))
    const release = jobOf(`
on:
  workflow_dispatch:
  push:
    tags: ["v*"]
jobs: { test: { steps: [] } }
`)
    expect(release.unsupported).toEqual([
      { feature: "trigger-filter", detail: `${file}: push runs only for matching tags` },
      { feature: "release-trigger", detail: `${file}: push runs only for tags` }
    ])
    // A push that also names branches, or a workflow a pull request also starts, runs for a change.
    expect(featuresFor("  push: { branches: [main], tags: ['v*'] }")).toEqual(["trigger-filter"])
    expect(featuresFor("  push: { branches-ignore: [wip], tags: ['v*'] }")).toEqual(["trigger-filter"])
    expect(featuresFor("  push: { tags: ['v*'] }\n  pull_request:")).toEqual(["trigger-filter"])
    expect(featuresFor("  push: { tags: ['v*'] }\n  merge_group:")).toEqual(["trigger-filter"])
    expect(featuresFor("  push: { tags-ignore: ['v*'] }")).toEqual(["trigger-filter"])
    expect(featuresFor("  push: { paths: [src/**] }")).toEqual(["trigger-filter"])
    expect(featuresFor("  push:")).toEqual([])
  })

  it("reports a job its workflow or its own permissions let write", () => {
    const written = (permissions: string, own = ""): ReadonlyArray<string> =>
      jobOf(`on: push\n${permissions}\njobs: { test: { ${own}steps: [] } }`).unsupported
        .filter((entry) => entry.feature === "write-permission").map((entry) => entry.detail)
    expect(written("permissions: { contents: write, id-token: write, issues: read }")).toEqual([
      `${file}: test may write contents, id-token`
    ])
    expect(written("permissions: write-all")).toEqual([`${file}: test may write every scope`])
    expect(written("permissions: read-all")).toEqual([])
    expect(written("permissions: { contents: read }")).toEqual([])
    expect(written("")).toEqual([])
    // A job's own permissions replace its workflow's.
    expect(written("permissions: { contents: write }", "permissions: { contents: read }, ")).toEqual([])
    expect(written("permissions: { contents: read }", "permissions: { packages: write }, ")).toEqual([
      `${file}: test may write packages`
    ])
    expect(written("permissions: { contents: write }", "permissions: {}, ")).toEqual([])
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
    // Without the default branch nobody can say what `github.ref` is, so the job stays out.
    expect(details(job)).toContain(
      `${file}: test runs only if github.ref == 'refs/heads/main': the default branch is not known here`
    )
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
      - uses: dorny/test-reporter@v2
        with: { name: tests, path: report.xml, reporter: java-junit }
`))
    expect(job.steps.map((step) => [step.id, step.command])).toEqual([["ci.yml:test:1", "bun test"]])
    expect(job.unsupported).toEqual([
      { feature: "host-action", detail: `${file}: actions/checkout@v4 has no command to run` },
      { feature: "uses", detail: `${file}: dorny/test-reporter@v2 has no command to run` }
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

  it("reports a step allowed to fail, and keeps the command", () => {
    const job = jobOf(withSteps(`
      - run: bun test
        if: always()
        continue-on-error: true
      - run: bun lint
        continue-on-error: false
      - run: bun fmt
        continue-on-error: \${{ runner.environment == 'github-hosted' }}
`))
    expect(job.steps).toHaveLength(3)
    expect(job.unsupported).toEqual([
      { feature: "continue-on-error", detail: `${file}: test step 1 may fail without failing the job` }
    ])
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
    // A step after the first reads a variable of the job when it runs: any step before it may have set it anew.
    expect(second?.command).toBe("echo \${{ env.LEVEL }}")
    expect(second?.env).toMatchObject({ LEVEL: "job" })
  })

  it("reports env it cannot read and leaves those variables out", () => {
    const job = jobOf(withSteps(`
      - run: echo \${{ env.TITLE }}
        env:
          TITLE: \${{ github.retention_days }}
          LIST: [a]
      - run: echo ok
        env: \${{ fromJSON(vars.ENV) }}
`))
    expect(job.steps.map((step) => step.command)).toEqual(["echo ok"])
    expect(job.steps.map((step) => step.env)).toEqual([{}])
    const unread = "github.retention_days: github.retention_days is known only on GitHub"
    expect(job.unsupported).toEqual([
      { feature: "expression", detail: `${file}: test step 1 sets TITLE from ${unread}` },
      { feature: "malformed-env", detail: `${file}: test step 1 sets LIST to a list or mapping` },
      // A variable nobody could read is not read as empty: the step that reads it is refused.
      { feature: "expression", detail: `${file}: test step 1 depends on env.TITLE: ${unread}` },
      { feature: "expression", detail: `${file}: test step 2 computes its whole environment` }
    ])
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
    expect(job.steps[0]).toMatchObject({
      command: "bun test --shard=${{ matrix.shard }}/2 --node=${{ matrix.node.version }}",
      cwd: "packages/${{ matrix.shard }}",
      env: { SHARD: "${{ matrix.shard }}" }
    })
    // GitHub reads a matrix key no variant has, and an input a push does not give, as empty. The commit is
    // filled in when the step runs.
    expect(job.steps.slice(1).map((step) => step.command)).toEqual(["echo", "echo ${{ github.sha }}"])
    expect(job.unsupported).toEqual([])
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

  it("withholds a URL whose path is long enough to be the credential, as a webhook's is", () => {
    // Review finding 6: this value was printed by `inventory --json` and written into the generated PACKAGE.ts.
    const webhook = "https://hooks.example.com/services/T000/B000/PLANTED-value-13"
    const job = jobOf(withSteps(`
      - run: echo ok
        env:
          webhook: ${webhook}
          DOCS: https://example.com/docs/ci
          HOME_PAGE: https://example.com
          EXACT: https://example.com/1234567890123456789
          SHORT: https://example.com/123456789012345678
          WITH_QUERY: https://example.com/short?ref=${"x".repeat(40)}
          NOT_A_URL: packages/app/src/generated/schema/index.ts
`))
    expect(job.steps[0]?.env).toEqual({
      DOCS: "https://example.com/docs/ci",
      HOME_PAGE: "https://example.com",
      // 19 characters after the slash make a path of 20; 18 do not.
      SHORT: "https://example.com/123456789012345678",
      WITH_QUERY: `https://example.com/short?ref=${"x".repeat(40)}`,
      NOT_A_URL: "packages/app/src/generated/schema/index.ts"
    })
    expect(job.steps[0]?.secretEnv).toEqual({ webhook: "webhook", EXACT: "EXACT" })
    expect(job.steps[0]?.secrets).toEqual(["webhook", "EXACT"])
    expect(JSON.stringify(job)).not.toContain("PLANTED")
    expect(features(job)).toContain("secret-value")
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
      - id: made
        run: j
      - run: k
        working-directory: \${{ steps.made.outputs.dir }}
      - run: l
        working-directory: \${{ github.retention_days }}/x
      - run: m
        working-directory: \${{ github.workspace }}
`)
    expect(job.steps.map((step) => [step.command, step.cwd])).toEqual([
      ["a", "from-workflow"],
      ["b", "packages/y"],
      // Steps ran before these two, so a directory from a variable or a step's output is entered when the step runs.
      ["c", ""],
      ["d", "tools"],
      ["e", ""],
      // No step is named `root`, so GitHub reads its output as empty: the repository root.
      ["h", ""],
      ["j", "from-workflow"],
      ["k", ""],
      ["m", ""]
    ])
    expect(job.steps[2]?.runner).toContain(`__ci_enter "$__v`)
    expect(details(job)).toEqual([
      `${file}: test step 6: its directory /tmp is outside the repository`,
      `${file}: test step 7: its directory ../outside is outside the repository`,
      `${file}: test step 9: its directory comes from secret DIR`,
      `${file}: test step 12: its directory comes from github.retention_days: github.retention_days is known only on GitHub`
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
    expect(job.steps[0]).toMatchObject({ cwd: "job", command: "a" })
    expect(job.steps[0]?.runner).toContain(`"$__script" 'sh' '-e'`)
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
    expect(shellOnly.steps[0]).toMatchObject({ cwd: "workflow", command: "a" })
    expect(shellOnly.steps[0]?.runner).toContain(`"$__script" 'sh' '-e'`)
  })

  // "Workflow syntax: jobs.<job_id>.steps[*].shell": `bash` is `bash --noprofile --norc -eo pipefail {0}`, and a
  // step that names no shell runs under `bash -e {0}`.
  it("runs a step under the shell it names", () => {
    const job = jobOf(withSteps(`
      - run: echo "it's"
        shell: bash
      - run: echo two
        shell: bash -e {0}
      - run: print("no")
        shell: python
      - run: echo three
        shell: 7
      - run: echo four
`))
    expect(job.steps.map((step) => step.command)).toEqual([`echo "it's"`, "echo two", "echo four"])
    expect(job.steps.map((step) => step.runner?.split("\n").at(-2))).toEqual([
      `__ci_run '-1' "$__script" 'bash' '--noprofile' '--norc' '-eo' 'pipefail'`,
      `__ci_run '-2' "$__script" 'bash' '-e'`,
      `__ci_run '-5' "$__script" 'bash' '-e'`
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
    // The Windows variant is left out where the job is replayed, so the job keeps its command and has no blocker.
    expect(some.steps).toHaveLength(1)
    expect(some.unsupported).toEqual([])
    expect(some.matrix).toEqual([{ os: "ubuntu-latest" }, { os: "windows-latest" }])
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

  it("reports a command that reads a runner variable a replay cannot give", () => {
    const job = jobOf(withSteps(`
      - run: echo x >> "$GITHUB_OUTPUT"; echo "$RUNNER_TEMP $GITHUB_WORKSPACE $GITHUB_SHA $CI"
      - run: gh api "repos/$GITHUB_REPOSITORY" --jq "$GITHUB_TOKEN$GITHUB_REF_PROTECTED"
      - run: echo "$GITHUB_REF"
        env: { GITHUB_REF: mine }
`))
    // The repository's name is not known in this test, and no runner says whether a ref is protected.
    expect(job.steps.map((step) => step.id)).toEqual(["ci.yml:test:1", "ci.yml:test:2"])
    expect(job.unsupported).toEqual([
      {
        feature: "runner-variable",
        detail: `${file}: test step 2 reads GITHUB_REPOSITORY, GITHUB_TOKEN, GITHUB_REF_PROTECTED`
      }
    ])
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
      `${file}: test sets C from env.A: env is not a context an expression can read`,
      `${file}: the workflow sets B from env.A: env is not a context an expression can read`
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
    expect(details(job)).toEqual([`${file}: test puts a matrix value holding a quote into a script`])
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
  it("records the tools setup actions stand for, with their job, and their version when it is known", () => {
    const { jobs, toolchains } = read(`
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
        with: { go-version: "1.\${{ matrix.go }}.x" }
      - uses: pnpm/action-setup@v4
      - uses: mlugg/setup-zig@v2
        with: { version: "" }
      - uses: actions/setup-python@v5
        with: { python-version: [a] }
      - uses: astral-sh/setup-uv@v9
        with: { version: "\${{ vars.UV }}" }
      - uses: hashicorp/setup-terraform@v3
        with: { terraform_version: "\${{ secrets.PIN }}" }
      - uses: actions/checkout@v4
`)
    const tool = (name: string, action: string) => ({ name, source: file, job: "ci.yml:test", action })
    expect(toolchains).toEqual([
      { ...tool("bun", "oven-sh/setup-bun@v2"), version: "1.3.0" },
      { ...tool("node", "actions/setup-node@v4"), version: "22" },
      // A matrix value stays as written: each variant of the job fills it in.
      { ...tool("go", "actions/setup-go@v5"), version: "1.${{ matrix.go }}.x" },
      tool("pnpm", "pnpm/action-setup@v4"),
      tool("zig", "mlugg/setup-zig@v2"),
      tool("python", "actions/setup-python@v5"),
      // A version from a value this file does not hold, or from a secret, is not a version.
      tool("uv", "astral-sh/setup-uv@v9"),
      tool("terraform", "hashicorp/setup-terraform@v3")
    ])
    // Each is left out as a step, but for the cache `actions/setup-go` keeps from version 4 on (`SetupCache.ts`);
    // the one that receives a secret keeps its job from running.
    expect(features(jobs[0] as Job).filter((feature) => feature === "host-action")).toHaveLength(9)
    expect(jobs[0]?.unsupported.filter((entry) => entry.feature !== "host-action")).toEqual([{
      feature: "secret",
      detail: `${file}: test step 8: hashicorp/setup-terraform@v3 receives PIN`
    }])
    expect(jobs[0]?.steps.map((step) => step.name)).toEqual(["actions/setup-go@v5", "Post actions/setup-go@v5"])
    // The version is a matrix value, so each variant's cache has a key of its own.
    expect(jobs[0]?.steps[0]?.runner).toContain("'setup-go-1.'")
  })

  it("reads a setup action outside any list by its name, and runs what it also runs", () => {
    const { jobs, toolchains } = read(`
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    env: { RAILS_ENV: test }
    steps:
      - uses: ruby/setup-ruby@v1
        with: { ruby-version: 3.4.6, bundler-cache: true }
      - name: Install with pnpm
        uses: pnpm/action-setup@v4
        with: { run_install: true }
      - run: bundle exec rake
  docs:
    runs-on: ubuntu-latest
    steps:
      - uses: ruby/setup-ruby@v1
        with: { bundler-cache: true, working-directory: docs }
      - run: bundle exec jekyll build
`)
    expect(toolchains.map((tool) => [tool.name, tool.job, tool.version])).toEqual([
      ["ruby", "ci.yml:test", "3.4.6"],
      ["pnpm", "ci.yml:test", undefined],
      ["ruby", "ci.yml:docs", undefined]
    ])
    expect(jobs[0]?.steps.map((step) => [step.name, step.command, step.env])).toEqual([
      ["ruby/setup-ruby@v1", "bundle config set --local path vendor/bundle\nbundle install --jobs 4", {
        RAILS_ENV: "test"
      }],
      ["Install with pnpm", "pnpm install", { RAILS_ENV: "test" }],
      [undefined, "bundle exec rake", { RAILS_ENV: "test" }]
    ])
    expect(features(jobs[0] as Job)).toEqual(["host-action", "host-action"])
    // What the action runs was not read, so the job is not run.
    expect(jobs[1]?.unsupported).toEqual([
      { feature: "host-action", detail: `${file}: ruby/setup-ruby@v1 has no command to run` },
      {
        feature: "uses",
        detail: `${file}: docs step 1: ruby/setup-ruby@v1 installs gems in a way that was not read (bundler-cache)`
      }
    ])
  })
})

describe("readWorkflow setup actions and secrets", () => {
  it("does not run a job whose setup action receives a secret, and reads the token every job has as none", () => {
    const { jobs } = read(`
on: push
jobs:
  plan:
    runs-on: ubuntu-latest
    steps:
      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: 1.9.0
          cli_config_credentials_token: \${{ secrets.TF_API_TOKEN }}
      - run: terraform plan
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: astral-sh/setup-uv@v9
        with:
          github-token: \${{ github.token }}
          enable-cache: true
      - uses: actions/setup-node@v4
        with: { token: "\${{ secrets.GITHUB_TOKEN }}" }
      - run: uv sync
`)
    expect(jobs[0]?.unsupported).toEqual([
      { feature: "host-action", detail: `${file}: hashicorp/setup-terraform@v3 has no command to run` },
      { feature: "secret", detail: `${file}: plan step 1: hashicorp/setup-terraform@v3 receives TF_API_TOKEN` }
    ])
    expect(features(jobs[1] as Job)).toEqual(["host-action", "host-action"])
  })
})

describe("readWorkflow remote cache credentials", () => {
  it("runs a job without its remote cache, as a pull request from a fork does, and still stops at any other secret", () => {
    // The variables left empty are named on each step where the files' jobs are joined into an inventory.
    const jobsOf = (text: string) => assemble("r", "c", [read(text)]).jobs
    const jobs = jobsOf(`
on: pull_request
env:
  TURBO_TOKEN: \${{ secrets.TURBO_TOKEN }}
  TURBO_TEAM: \${{ secrets.TURBO_TEAM }}
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm turbo run lint
      - run: pnpm turbo run build
        env: { TURBO_TEAM: acme }
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm publish
        env: { NPM_TOKEN: "\${{ secrets.NPM_TOKEN }}" }
`)
    expect(jobs[0]?.unsupported).toEqual([])
    expect(jobs[0]?.steps).toEqual([
      {
        id: "ci.yml:lint:1",
        command: "pnpm turbo run lint",
        cwd: "",
        env: { TURBO_TOKEN: "", TURBO_TEAM: "" },
        secrets: [],
        withheld: ["TURBO_TEAM", "TURBO_TOKEN"],
        runner: expect.any(String)
      },
      {
        id: "ci.yml:lint:2",
        command: "pnpm turbo run build",
        cwd: "",
        env: { TURBO_TOKEN: "", TURBO_TEAM: "acme" },
        secrets: [],
        withheld: ["TURBO_TOKEN"],
        runner: expect.any(String)
      }
    ])
    // No secret is passed, and none is named as received.
    expect(JSON.stringify(jobs[0])).not.toContain("secrets.")
    expect(jobs[1]?.steps[0]).toMatchObject({
      secrets: ["NPM_TOKEN"],
      secretEnv: { NPM_TOKEN: "NPM_TOKEN" },
      withheld: ["TURBO_TEAM", "TURBO_TOKEN"]
    })
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
env: { DAYS: "\${{ github.retention_days }}" }
jobs:
  a: { runs-on: x, steps: [] }
  b: { runs-on: x, steps: [] }
`)
    const problem =
      `${file}: the workflow sets DAYS from github.retention_days: github.retention_days is known only on GitHub`
    expect(jobs.map((job) => details(job))).toEqual([[problem], [problem]])
  })
})
