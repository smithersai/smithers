import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Job } from "../../src/contract/Inventory.vibe"
import { defaultVariables } from "../../src/inventory/Contexts.vibe"
import { readWorkflow } from "../../src/inventory/GithubActions.vibe"
import { installsOf } from "../../src/inventory/MachineChanges.vibe"
import { githubDefaultVariables } from "./githubDefaultVariables.ts"
import { commits, jobsOf, type Repository, repository, runJob } from "./run.ts"

const file = ".github/workflows/ci.yml"

const made: Array<Repository> = []

/** A repository holding one workflow and the files given, read as a pull request to `main`. */
const withWorkflow = (workflow: string, files: Readonly<Record<string, string>> = {}): Repository => {
  const repo = repository({ [file]: workflow, ...files })
  made.push(repo)
  return repo
}

const jobOf = (repo: Repository, id: string): Job => {
  const job = jobsOf(repo, file).find((candidate) => candidate.id === id)
  if (job === undefined) throw new Error(`no job ${id}`)
  return job
}

const features = (job: Job) => job.unsupported.map((entry) => entry.feature)
const details = (job: Job) => job.unsupported.map((entry) => entry.detail.slice(entry.detail.indexOf(": ") + 2))
const outputs = (ran: ReadonlyArray<{ readonly output: string }>) => ran.map((step) => step.output.trim())

afterEach(() => {
  for (const repo of made.splice(0)) repo.remove()
})

describe("a workflow read and run as a pull request", () => {
  // "Contexts: steps context": `steps.<id>.outputs.<name>` is what the step wrote to GITHUB_OUTPUT.
  // "Workflow commands: Setting an output parameter".
  it("gives a later step what an earlier step wrote to GITHUB_OUTPUT, in its condition, its variables and its script", () => {
    const repo = withWorkflow(`
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - id: pick
        run: |
          echo "lane=fast" >> "$GITHUB_OUTPUT"
          echo "run=true" >> "$GITHUB_OUTPUT"
      - if: steps.pick.outputs.run == 'true'
        env:
          LANE: \${{ steps.pick.outputs.lane }}
          MODE: \${{ steps.pick.outputs.lane == 'fast' && 'quick' || 'full' }}
        run: echo "$LANE $MODE \${{ steps.pick.outputs.lane }}"
      - if: steps.pick.outputs.run != 'true'
        run: echo never
      - run: echo "\${{ steps.pick.outputs.absent }}|\${{ steps.nobody.outputs.x }}|"
`)
    const job = jobOf(repo, "ci.yml:test")
    expect(job.unsupported).toEqual([])
    expect(job.steps[1]?.command).toBe(`echo "$LANE $MODE \${{ steps.pick.outputs.lane }}"`)
    expect(outputs(runJob(repo, job))).toEqual([
      "",
      "fast quick fast",
      "smithers-ci: not run, its condition is false",
      "||"
    ])
  })

  // "Events that trigger workflows: pull_request": `github.event.pull_request.head.sha` and `base.sha`.
  it("stands for a pull request whose head is the commit and whose base is its first parent", () => {
    const repo = withWorkflow(`
on:
  pull_request:
  merge_group:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - env:
          BASE: \${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || github.event.merge_group.base_sha }}
          HEAD: \${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}
        run: echo "$BASE $HEAD $GITHUB_SHA $GITHUB_EVENT_NAME $GITHUB_BASE_REF \${{ github.repository }}"
      - run: test "$(git merge-base "\${{ github.event.pull_request.base.sha }}" "\${{ github.sha }}")" = "\${{ github.event.pull_request.base.sha }}"
      - run: cat "$GITHUB_EVENT_PATH"
`)
    const { head, parent } = commits(repo)
    const ran = runJob(repo, jobOf(repo, "ci.yml:test"))
    expect(ran.map((step) => step.status)).toEqual([0, 0, 0])
    expect(ran[0]?.output.trim()).toBe(`${parent} ${head} ${head} pull_request main acme/widgets`)
    expect(JSON.parse(ran[2]?.output ?? "")).toEqual({
      pull_request: {
        head: { sha: head, repo: { full_name: "acme/widgets", default_branch: "main", fork: false } },
        base: { sha: parent, ref: "main", repo: { full_name: "acme/widgets", default_branch: "main", fork: false } },
        labels: [],
        draft: false
      },
      repository: { full_name: "acme/widgets", default_branch: "main" }
    })
  })

  it("leaves out a step whose condition is false for a pull request, and says so", () => {
    const repo = withWorkflow(`
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - if: github.event_name == 'push' && github.ref == 'refs/heads/main'
        run: ./deploy.sh
        env: { DEPLOY_TOKEN: "\${{ secrets.DEPLOY_TOKEN }}" }
      - if: contains(github.event.pull_request.labels.*.name, 'preview')
        id: preview
        run: ./preview.sh
      - if: steps.preview.outcome == 'success'
        run: ./announce.sh
      - if: failure()
        run: ./collect-logs.sh
      - if: \${{ !cancelled() && steps.preview.conclusion == 'skipped' }}
        run: echo ran
`)
    const job = jobOf(repo, "ci.yml:test")
    expect(job.steps.map((step) => step.command)).toEqual(["echo ran"])
    expect(features(job)).toEqual(["condition-false", "condition-false", "condition-false", "condition-false"])
    expect(details(job)[0]).toBe(
      "test step 1 is left out: github.event_name == 'push' && github.ref == 'refs/heads/main' is false for a pull request to main"
    )
    expect(outputs(runJob(repo, job))).toEqual(["ran"])
  })

  it("leaves a job out whose condition is false, or that nobody can evaluate, with the reason", () => {
    const repo = withWorkflow(`
on: pull_request
jobs:
  release:
    if: github.base_ref == 'release'
    runs-on: ubuntu-latest
    steps: [{ run: ./release.sh }]
  gated:
    if: needs.release.outputs.go == 'true'
    needs: release
    runs-on: ubuntu-latest
    steps: [{ run: ./gated.sh }]
  titled:
    if: startsWith(github.event.pull_request.title, 'feat')
    runs-on: ubuntu-latest
    steps: [{ run: ./titled.sh }]
  late:
    if: github.sha != ''
    runs-on: ubuntu-latest
    steps: [{ run: ./late.sh }]
  mixed:
    if: "\${{ true }} && false"
    runs-on: ubuntu-latest
    steps: [{ run: ./mixed.sh }]
  kept:
    if: \${{ always() && github.base_ref == 'main' }}
    runs-on: ubuntu-latest
    steps: [{ run: echo kept }]
`)
    const reasons = (id: string) => details(jobOf(repo, `ci.yml:${id}`))
    expect(reasons("release")).toEqual([
      "release is left out: github.base_ref == 'release' is false for a pull request to main"
    ])
    expect(reasons("gated")).toEqual([
      "gated runs only if needs.release.outputs.go == 'true': what another job gave is known only while the run goes"
    ])
    expect(reasons("titled")).toEqual([
      "titled runs only if startsWith(github.event.pull_request.title, 'feat'): github.event.pull_request.title is known only on GitHub"
    ])
    expect(reasons("late")).toEqual(["late runs only if github.sha != '': it is decided while the job runs"])
    // Text around a `${{ }}` makes the whole a text on GitHub, and a text that is not empty is true.
    expect(reasons("mixed")).toEqual([])
    expect(reasons("kept")).toEqual([])
    expect(features(jobOf(repo, "ci.yml:release"))).toEqual(["condition"])
  })

  // "Workflow commands: Setting an environment variable" and "Adding a system path".
  it("gives later steps what a step wrote to GITHUB_ENV and GITHUB_PATH, and reads env from it", () => {
    const repo = withWorkflow(`
on: pull_request
env: { LEVEL: workflow, OTHER: kept }
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ env.LEVEL }} \${{ env.NEVER }}|"
      - run: |
          mkdir -p "$RUNNER_TEMP/bin"
          printf '#!/bin/sh\\necho tool ran\\n' > "$RUNNER_TEMP/bin/my-tool"
          chmod +x "$RUNNER_TEMP/bin/my-tool"
          echo "$RUNNER_TEMP/bin" >> "$GITHUB_PATH"
          echo "LEVEL=step-two" >> "$GITHUB_ENV"
          echo "MADE=yes" >> "$GITHUB_ENV"
      - run: my-tool && echo "$LEVEL \${{ env.LEVEL }} \${{ env.MADE }} \${{ env.OTHER }} \${{ env.NEVER }}|"
      - env: { LEVEL: mine }
        if: env.MADE == 'yes' && env.LEVEL == 'mine'
        run: echo "$LEVEL \${{ env.LEVEL }}"
`)
    const job = jobOf(repo, "ci.yml:test")
    expect(job.unsupported).toEqual([])
    // Before any step names GITHUB_ENV a variable is read from the file; after, when the step runs.
    expect(job.steps.map((step) => step.command)).toEqual([
      `echo "workflow |"`,
      expect.stringContaining("GITHUB_PATH"),
      `my-tool && echo "$LEVEL \${{ env.LEVEL }} \${{ env.MADE }} \${{ env.OTHER }} \${{ env.NEVER }}|"`,
      `echo "$LEVEL mine"`
    ])
    expect(outputs(runJob(repo, job))).toEqual([
      "workflow |",
      "",
      "tool ran\nstep-two step-two yes kept |",
      "mine mine"
    ])
  })

  // A program a step starts can write to GITHUB_ENV with the step's text never naming the file.
  it("reads a variable when the step runs once any step ran before it, however that step set it", () => {
    const repo = withWorkflow(
      `
on: pull_request
env: { LEVEL: workflow, DEPLOY: "false" }
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - if: env.DEPLOY == 'true'
        run: echo never
      - run: sh ./set.sh
      - if: env.DEPLOY == 'true'
        run: echo "\${{ env.LEVEL }} $DEPLOY"
`,
      { "set.sh": "echo LEVEL=changed >> \"$GITHUB_ENV\"\necho DEPLOY=true >> \"$GITHUB_ENV\"\n" }
    )
    const job = jobOf(repo, "ci.yml:test")
    // Nothing ran before the first step, so its condition is decided from the file.
    expect(features(job)).toEqual(["condition-false"])
    expect(outputs(runJob(repo, job))).toEqual(["", "changed true"])
  })

  it("runs a matrix job once per variant, each with its own values and its own state", () => {
    const repo = withWorkflow(`
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        lane: [core, voice]
        shard: [1]
    steps:
      - id: mark
        run: echo "lane=\${{ matrix.lane }}" >> "$GITHUB_OUTPUT"
      - if: steps.mark.outputs.lane == 'voice' && matrix.lane == 'voice'
        run: echo "only \${{ matrix.lane == 'voice' && '--filter=voice' || '' }} \${{ matrix.shard }}/\${{ strategy.job-total }}"
      - if: matrix.shard == 1
        run: echo numeric
`)
    const job = jobOf(repo, "ci.yml:test")
    // A number in a matrix is compared as a number, for each variant.
    expect(details(job)).toEqual([])
    expect(outputs(runJob(repo, job, { lane: "core", shard: "1" }))).toEqual([
      "",
      "smithers-ci: not run, its condition is false",
      "numeric"
    ])
    expect(outputs(runJob(repo, job, { lane: "voice", shard: "1" }))).toEqual([
      "",
      "only --filter=voice 1/2",
      "numeric"
    ])
  })

  // spf13/cobra's test job: the value depends on two matrix keys, and one of them is ordered as a number.
  it("works out a job's env value with && and || for each matrix variant", () => {
    const repo = withWorkflow(`
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        platform: [ubuntu, macOS]
        go: [17, 24]
    env:
      FLAGS: \${{ matrix.platform == 'macOS' && matrix.go < 24 && '-external' || '' }}
    steps:
      - run: echo "[$FLAGS]"
`)
    const job = jobOf(repo, "ci.yml:test")
    expect(details(job)).toEqual([])
    const flags = (platform: string, go: string) => outputs(runJob(repo, job, { platform, go }))
    expect(flags("macOS", "17")).toEqual(["[-external]"])
    expect(flags("macOS", "24")).toEqual(["[]"])
    expect(flags("ubuntu", "17")).toEqual(["[]"])
  })

  it("refuses a comparison of a value only the running job knows", () => {
    const repo = withWorkflow(`
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - id: mark
        run: echo "n=1" >> "$GITHUB_OUTPUT"
      - if: steps.mark.outputs.n < 2
        run: echo reached
`)
    expect(details(jobOf(repo, "ci.yml:test"))).toEqual([
      "test step 2: < orders values decided while the job runs, which a shell does not do as GitHub does"
    ])
  })

  // "hashFiles": the SHA-256 of the files' SHA-256 hashes.
  it("works out hashFiles of named files, and refuses a wildcard", () => {
    const repo = withWorkflow(
      `
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ hashFiles('bun.lock') }}"
      - run: echo "\${{ hashFiles('**/bun.lock') }}"
`,
      { "bun.lock": "lock\n" }
    )
    const job = jobOf(repo, "ci.yml:test")
    expect(details(job)).toEqual([
      "test step 2 depends on hashFiles('**/bun.lock'): hashFiles with a wildcard or a path outside the repository is not worked out off GitHub"
    ])
    // The SHA-256 of the file's own SHA-256, as `hashFiles` computes it for one file.
    const expected = createHash("sha256").update(createHash("sha256").update("lock\n").digest()).digest("hex")
    expect(outputs(runJob(repo, job))).toEqual([expected])
  })
})

describe("actions", () => {
  const action = `
name: Setup
inputs:
  tool:
    description: The tool to install
    default: hammer
  install:
    default: "true"
  unused:
    description: Has no default
outputs:
  where:
    value: \${{ steps.place.outputs.dir }}
  fixed:
    value: always-\${{ inputs.tool }}
runs:
  using: composite
  steps:
    - id: place
      shell: bash
      run: |
        echo "dir=$GITHUB_ACTION_PATH" >> "$GITHUB_OUTPUT"
        echo "TOOL_HOME=\${{ github.action_path }}/home" >> "$GITHUB_ENV"
    - if: inputs.install == 'true'
      shell: bash
      env:
        TOOL: \${{ inputs.tool }}
      run: echo "installing $TOOL \${{ inputs.tool }} [\${{ inputs.unused }}] [\${{ inputs.nothing }}] $OUTER"
    - if: \${{ inputs.install != 'true' }}
      shell: bash
      run: echo skipped install
    - if: steps.place.outputs.dir != '' && inputs.tool == 'wrench'
      shell: bash
      run: echo placed
`

  // "Creating a composite action": its steps run in the job, with `inputs` from `with:` and the defaults.
  it("reads a local composite action as its own steps, with its inputs, its condition and its outputs", () => {
    const repo = withWorkflow(
      `
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - id: pick
        run: echo "go=yes" >> "$GITHUB_OUTPUT"
      - id: setup
        if: steps.pick.outputs.go == 'yes'
        uses: ./.github/actions/setup
        env: { OUTER: from-caller }
        with:
          tool: \${{ steps.pick.outputs.go == 'yes' && 'wrench' || 'none' }}
      - run: echo "\${{ steps.setup.outputs.where }} \${{ steps.setup.outputs.fixed }} \${{ steps.setup.outputs.none }}| $TOOL_HOME"
      - uses: ./.github/actions/setup
        with: { install: "false", tool: saw }
`,
      { ".github/actions/setup/action.yml": action }
    )
    const job = jobOf(repo, "ci.yml:test")
    expect(features(job)).toEqual(["condition-false", "condition-false", "condition-false"])
    const ran = runJob(repo, job)
    const directory = `${repo.root}/.github/actions/setup`
    expect(outputs(ran)).toEqual([
      "",
      "",
      "installing wrench wrench [] [] from-caller",
      "placed",
      `${directory} always-wrench | ${directory}/home`,
      "",
      "skipped install"
    ])
  })

  it("reports a step of an action that reads an input nobody can know, or a secret", () => {
    const repo = withWorkflow(
      `
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/setup
        with: { tool: "\${{ github.retention_days }}", install: "\${{ secrets.INSTALL }}" }
`,
      { ".github/actions/setup/action.yml": action }
    )
    expect(details(jobOf(repo, "ci.yml:test"))).toEqual([
      "test step 1 > step 2 sets TOOL from inputs.tool: github.retention_days: github.retention_days is known only on GitHub",
      "test step 1 > step 2 runs only if inputs.install == 'true': it reads secret INSTALL",
      "test step 1 > step 3 runs only if \${{ inputs.install != 'true' }}: it reads secret INSTALL",
      "test step 1 > step 4 runs only if steps.place.outputs.dir != '' && inputs.tool == 'wrench': github.retention_days: github.retention_days is known only on GitHub"
    ])
  })

  it("leaves a job out when a local action cannot be read, is not composite, or nests without end", () => {
    const repo = withWorkflow(
      `
on: pull_request
jobs:
  missing:
    runs-on: ubuntu-latest
    steps: [{ uses: ./actions/missing }, { run: echo a }]
  broken:
    runs-on: ubuntu-latest
    steps: [{ uses: ./actions/broken }]
  node:
    runs-on: ubuntu-latest
    steps: [{ id: js, uses: ./actions/node }, { run: "echo \${{ steps.js.outputs.x }}" }]
  outside:
    runs-on: ubuntu-latest
    steps: [{ uses: ./../elsewhere }]
  loop:
    runs-on: ubuntu-latest
    steps: [{ uses: ./actions/loop }]
`,
      {
        "actions/broken/action.yaml": "runs: [unclosed",
        "actions/node/action.yml": "runs: { using: node20, main: index.js }",
        "actions/loop/action.yml": "runs: { using: composite, steps: [{ uses: ./actions/loop }] }"
      }
    )
    const reasons = (id: string) => details(jobOf(repo, `ci.yml:${id}`))
    expect(reasons("missing")).toEqual(["./actions/missing has no command to run"])
    expect(reasons("broken")[0]).toMatch(/^\.\/actions\/broken: its action file does not parse/)
    expect(reasons("node")).toEqual([
      "./actions/node: it runs with node20, and only a composite action has steps to read",
      "node step 2 depends on steps.js.outputs.x: how a step ended is known only when its condition is"
    ])
    expect(reasons("outside")).toEqual(["./../elsewhere has no command to run"])
    expect(reasons("loop")).toEqual(["./actions/loop has no command to run"])
    expect(features(jobOf(repo, "ci.yml:loop"))).toEqual(["uses"])
  })

  // A setup action installs a tool on GitHub. A replay installs nothing: it looks for the tool on the machine before
  // it runs the job (`Tools.ts`), so the step adds no command. What the action would have set or given is not known.
  it("reads a setup action as a tool the job needs, with no command of its own", () => {
    const setup = (last: string) => `
on: pull_request
env: { NODE: 24.15.0 }
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - id: node
        uses: actions/setup-node@v4
        with: { node-version: "\${{ env.NODE }}" }
        env: { IGNORED: "\${{ github.retention_days }}" }
      - if: steps.node.outcome == 'success'
        run: echo "node is here \${{ env.JAVA_HOME }}|"
      - uses: actions/setup-java@v4
        with: { java-version: 21 }
      - run: ${last}
`
    const repo = withWorkflow(setup("echo done"))
    const job = jobOf(repo, "ci.yml:test")
    expect(job.steps.map((step) => step.command)).toEqual([`echo "node is here |"`, "echo done"])
    // The step's own `env:` reaches only the action, so one that cannot be read keeps no job out.
    expect(details(job)).toEqual([
      "actions/setup-node@v4 has no command to run",
      "actions/setup-java@v4 has no command to run"
    ])
    expect(outputs(runJob(repo, job))).toEqual(["node is here |", "done"])
    const tools = readWorkflow(file, (repo.facts.read as (path: string) => string)(file), repo.facts).toolchains
    expect(tools).toEqual([
      { name: "node", source: file, job: "ci.yml:test", action: "actions/setup-node@v4", version: "24.15.0" },
      { name: "java", source: file, job: "ci.yml:test", action: "actions/setup-java@v4", version: "21" }
    ])

    const reads = (last: string) => details(jobOf(withWorkflow(setup(last)), "ci.yml:test")).at(-1)
    expect(reads(`echo "\${{ env.JAVA_HOME }}"`)).toBe(
      "test step 4 depends on env.JAVA_HOME: env.JAVA_HOME is set by a setup action, which a replay does not run"
    )
    expect(reads(`echo "\${{ steps.node.outputs.node-version }}"`)).toBe(
      "test step 4 depends on steps.node.outputs.node-version: an output of actions/setup-node@v4, which a replay does not run"
    )
  })

  // "actions/checkout": with no `ref` it checks out the commit that started the run, which is the copy a replay made.
  it("takes a checkout as the copy a replay made, and leaves the job out when it is another", () => {
    const repo = withWorkflow(`
on: pull_request
jobs:
  same:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: \${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}
          repository: acme/widgets
          submodules: false
      - uses: actions/checkout@v4
      - run: echo here
  other:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { ref: main, path: main-copy, repository: acme/tools, submodules: recursive, lfs: true }
      - uses: actions/checkout@v4
        with: { ref: "\${{ github.event.pull_request.base.sha }}" }
      - uses: actions/checkout@v4
        with: { ref: "\${{ github.retention_days }}" }
      - uses: actions/checkout@v4
        with: { ref: "refs/\${{ github.sha }}" }
`)
    expect(features(jobOf(repo, "ci.yml:same"))).toEqual(["host-action"])
    expect(details(jobOf(repo, "ci.yml:other")).filter((detail) => !detail.includes("has no command"))).toEqual([
      "other step 1 checks out another repository",
      "other step 1 checks the repository out into another directory",
      "other step 1 checks out a commit that may not be the one under replay",
      "other step 1 checks out submodules",
      "other step 1 checks out large files",
      "other step 2 checks out a commit that may not be the one under replay",
      "other step 3 checks out a commit that may not be the one under replay",
      "other step 4 checks out a commit that may not be the one under replay"
    ])
  })

  // "actions/cache": `cache-hit` is empty after a miss. A cache step whose key hashes a file outside the repository
  // cannot be kept here (`Cache.test.ts` has the ones that can), so it restores nothing.
  it("reads a cache step it cannot keep as a miss, keeps an upload for the runner, and leaves out a job that uses any other action", () => {
    const repo = withWorkflow(`
on: pull_request
jobs:
  cached:
    runs-on: ubuntu-latest
    steps:
      - id: cache
        uses: actions/cache@v4
        with: { path: node_modules, key: "deps-\${{ hashFiles('/etc/hostname') }}" }
      - if: steps.cache.outputs.cache-hit != 'true'
        run: echo install
      - id: upload
        if: always()
        uses: actions/upload-artifact@v4
        with: { name: logs, path: logs/ }
      - run: echo "\${{ steps.cache.outputs.cache-primary-key }}"
  later:
    runs-on: ubuntu-latest
    steps:
      - id: pick
        run: echo "go=yes" >> "$GITHUB_OUTPUT"
      - id: maybe
        if: steps.pick.outputs.go == 'yes'
        uses: actions/cache/restore@v4
      - run: echo "\${{ steps.maybe.outcome }}"
  downloads:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
      - uses: docker://alpine:3
      - if: github.event_name == 'push'
        uses: some/deploy-action@v1
`)
    const cached = jobOf(repo, "ci.yml:cached")
    expect(cached.steps.map((step) => step.command)).toEqual(["echo install"])
    expect(details(cached)).toEqual([
      "actions/cache@v4 has no command to run",
      "cached step 4 depends on steps.cache.outputs.cache-primary-key: an output of actions/cache@v4, which a replay does not run"
    ])
    // The upload is not run here: the workflow apply writes runs it on the runner.
    expect(cached.kept?.map((step) => step.uses)).toEqual(["actions/upload-artifact@v4"])
    expect(details(jobOf(repo, "ci.yml:later")).at(-1)).toBe(
      "later step 3 depends on steps.maybe.outcome: how a step ended is known only when its condition is"
    )
    const downloads = jobOf(repo, "ci.yml:downloads")
    expect(features(downloads)).toEqual(["uses", "uses", "condition-false"])
    expect(details(downloads)[0]).toBe("actions/download-artifact@v4 has no command to run")
  })
})

describe("a workflow another calls", () => {
  const called = `
on:
  workflow_call:
    inputs:
      head_sha: { type: string, required: true }
      base_sha: { type: string, default: "" }
      strict: { type: boolean, default: true }
      depth: { type: number }
      plain:
env: { SCANNER: gitleaks }
permissions: { contents: read }
defaults: { run: { shell: bash } }
jobs:
  scan:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
        with: { ref: "\${{ inputs.head_sha }}" }
      - env:
          BASE_SHA: \${{ inputs.base_sha }}
          HEAD_SHA: \${{ inputs.head_sha }}
        run: echo "$SCANNER $BASE_SHA $HEAD_SHA \${{ inputs.strict }} [\${{ inputs.depth }}\${{ inputs.plain }}\${{ inputs.undeclared }}] [$CALLER] \${{ github.job }} \${{ github.workflow }}"
      - if: inputs.strict
        run: echo strict
  report:
    needs: scan
    runs-on: ubuntu-24.04
    steps: [{ run: echo report }]
`

  // "Reusing workflows": a called workflow's jobs run in the caller's run, with `inputs` from `with:`.
  it("reads the jobs of a workflow in the repository that a job calls, with its inputs", () => {
    const repo = withWorkflow(
      `
name: Pull requests
on: pull_request
env: { CALLER: never-reaches-the-called-workflow }
jobs:
  lint:
    runs-on: ubuntu-latest
    steps: [{ run: echo lint }]
  secret-scan:
    needs: lint
    uses: ./.github/workflows/scan.yml
    with:
      head_sha: \${{ github.event.pull_request.head.sha }}
      base_sha: \${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}
  done:
    needs: secret-scan
    runs-on: ubuntu-latest
    steps: [{ run: echo done }]
`,
      { ".github/workflows/scan.yml": called }
    )
    const jobs = jobsOf(repo, file)
    expect(jobs.map((job) => [job.id, job.needs, job.file])).toEqual([
      ["ci.yml:lint", [], file],
      ["ci.yml:secret-scan", ["ci.yml:secret-scan/scan", "ci.yml:secret-scan/report"], file],
      ["ci.yml:secret-scan/scan", ["ci.yml:lint"], ".github/workflows/scan.yml"],
      ["ci.yml:secret-scan/report", ["ci.yml:secret-scan/scan", "ci.yml:lint"], ".github/workflows/scan.yml"],
      ["ci.yml:done", ["ci.yml:secret-scan"], file]
    ])
    const scan = jobOf(repo, "ci.yml:secret-scan/scan")
    expect(scan.triggers).toEqual(["pull_request"])
    expect(features(scan)).toEqual(["host-action"])
    const { head, parent } = commits(repo)
    // "on.workflow_call.inputs": an input given no value and no default is 0 for a number and empty for a string.
    expect(outputs(runJob(repo, scan))).toEqual([`gitleaks ${parent} ${head} true [0] [] scan Pull requests`, "strict"])
  })

  it("keeps the calling job as it was when the workflow it names cannot be read", () => {
    const repo = withWorkflow(
      `
on: pull_request
jobs:
  absent: { uses: ./.github/workflows/absent.yml }
  remote: { uses: acme/shared/.github/workflows/ci.yml@v1 }
  uncalled: { uses: ./.github/workflows/uncalled.yml }
  broken: { uses: ./.github/workflows/broken.yml }
  gated:
    if: github.base_ref == 'release'
    needs: { bad: true }
    uses: ./.github/workflows/scan.yml
    with: { head_sha: x, strict: false, depth: 2 }
  loop: { uses: ./.github/workflows/loop.yml }
`,
      {
        ".github/workflows/uncalled.yml": "on: push\njobs: { a: { runs-on: x, steps: [{ run: a }] } }",
        ".github/workflows/broken.yml": "jobs: [unclosed",
        ".github/workflows/scan.yml": called,
        ".github/workflows/loop.yml":
          "on: { workflow_call: }\nenv: { DAYS: \"\${{ github.retention_days }}\" }\njobs: { again: { uses: ./.github/workflows/loop.yml } }"
      }
    )
    const jobs = jobsOf(repo, file)
    const reasons = (id: string) => details(jobs.find((job) => job.id === id) as Job)
    for (const name of ["absent", "uncalled", "broken"]) {
      expect(reasons(`ci.yml:${name}`)).toEqual([
        `./.github/workflows/${name}.yml is a reusable workflow; its jobs were not read`
      ])
    }
    expect(reasons("ci.yml:remote")).toEqual([
      "acme/shared/.github/workflows/ci.yml@v1 is a reusable workflow; its jobs were not read"
    ])
    // What keeps the calling job out keeps every job it calls out.
    expect(reasons("ci.yml:gated/scan").slice(0, 2)).toEqual([
      "gated has a needs value that is not a job list",
      "gated is left out: github.base_ref == 'release' is false for a pull request to main"
    ])
    // The called job read its typed inputs: `strict: false` leaves its last step out.
    expect(reasons("ci.yml:gated/scan").at(-1)).toBe(
      "scan step 3 is left out: inputs.strict is false for a pull request to main"
    )
    // A workflow that calls itself is read four deep and no further, and its own problems are kept on its jobs.
    const deepest = jobs.filter((job) => job.id.startsWith("ci.yml:loop")).at(-1) as Job
    expect(deepest.id).toBe("ci.yml:loop/again/again/again/again")
    expect(details(deepest)).toEqual([
      "./.github/workflows/loop.yml is a reusable workflow; its jobs were not read",
      "the workflow sets DAYS from github.retention_days: github.retention_days is known only on GitHub"
    ])
  })
})

describe("what an expression of a step can read", () => {
  it("reads env at each level, as the step finds it when it runs", () => {
    const repo = withWorkflow(`
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    env:
      COMMIT: \${{ github.sha }}
      TOKEN: \${{ secrets.TOKEN }}
      my-var: plain
    steps:
      - env: { MINE: "\${{ github.sha }}", "odd-name": "\${{ github.sha }}" }
        run: echo hidden
      - env: { MINE: "\${{ github.sha }}" }
        run: echo "$COMMIT \${{ env.MINE }} \${{ env.COMMIT }} \${{ env['my-var'] }}[\${{ env['no-var'] }}]"
      - run: echo "\${{ env.TOKEN }}"
      - run: echo "COMMIT=replaced" >> "$GITHUB_ENV"
      - run: echo "\${{ env.COMMIT }} $COMMIT"
`)
    const job = jobOf(repo, "ci.yml:test")
    const { head } = commits(repo)
    expect(details(job)).toEqual([
      "test step 1 sets odd-name, a name a shell cannot hold, while the job runs",
      "test step 3 depends on secret TOKEN"
    ])
    expect(outputs(runJob(repo, job))).toEqual([`${head} ${head} ${head} plain[]`, "", "replaced replaced"])
  })

  // "Contexts": strategy.job-index, strategy.job-total, job.status, steps.<id>.conclusion.
  it("reads strategy, job and steps as far as they are known before the run", () => {
    const repo = withWorkflow(`
on: pull_request
jobs:
  single:
    runs-on: ubuntu-latest
    steps:
      - id: skipped
        if: github.event_name == 'push'
        run: echo never
      - id: ran
        run: echo "name with space=1" >> "$GITHUB_OUTPUT"
      - run: >-
          echo "\${{ strategy.job-index }}/\${{ strategy.job-total }} \${{ job.status }}
          \${{ steps.ran.conclusion }} \${{ steps.skipped.outcome }} [\${{ steps.skipped.outputs.x }}]
          [\${{ steps.ran.nothing }}]"
      - run: echo "\${{ job.container.id }}"
      - run: echo "\${{ strategy.max-parallel }}"
      - run: echo "\${{ steps.ran.outputs['name with space'] }}"
      - if: needs.other.outputs.x == 'true'
        run: echo gated
      - if: secrets.TOKEN != ''
        run: echo secret
      - if: [a]
        run: echo list
  many:
    runs-on: ubuntu-latest
    strategy: { matrix: { n: [a, b] } }
    steps: [{ run: "echo \${{ strategy.job-index }}" }]
`)
    const single = jobOf(repo, "ci.yml:single")
    expect(details(single).slice(1)).toEqual([
      "single step 4 depends on job.container.id: job.container is known only on GitHub",
      "single step 5 depends on strategy.max-parallel: strategy.max-parallel is known only while the run goes",
      "single step 6 depends on steps.ran.outputs['name with space']: steps.ran.outputs.name with space has a name a replay does not keep",
      "single step 7 runs only if needs.other.outputs.x == 'true': what another job gave is known only while the run goes",
      "single step 8 runs only if secrets.TOKEN != '': it reads secret TOKEN",
      "single step 9 runs only if a value that is not text: it is not text"
    ])
    expect(outputs(runJob(repo, single)).at(-1)).toBe("0/1 success success skipped [] []")
    expect(details(jobOf(repo, "ci.yml:many"))).toEqual([
      "many step 1 depends on strategy.job-index: strategy.job-index is known only while the run goes"
    ])
  })

  it("exports a variable of the job that is decided while the job runs, and lets GITHUB_ENV replace it", () => {
    const repo = withWorkflow(`
on: pull_request
env: { COMMIT: "\${{ github.sha }}" }
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo "$COMMIT"; echo "COMMIT=replaced" >> "$GITHUB_ENV"
      - run: echo "$COMMIT"
`)
    expect(outputs(runJob(repo, jobOf(repo, "ci.yml:test")))).toEqual([commits(repo).head, "replaced"])
  })

  it("reports a runner chosen by a repository variable or a value only the run knows", () => {
    const repo = withWorkflow(`
on: pull_request
jobs:
  hosted:
    runs-on: \${{ fromJSON(vars.FLEET_ONLINE != 'true' && '["ubuntu-24.04"]' || '["self-hosted","robot"]') }}
    steps: [{ run: "echo \${{ runner.os }} \${{ runner.arch }}" }]
  pooled:
    runs-on: [self-hosted, "pool-\${{ github.retention_days }}"]
    steps: [{ run: "echo \${{ runner.os }}" }]
  windows:
    runs-on: windows-latest
    steps:
      - id: node
        uses: actions/setup-node@v4
  conditional:
    runs-on: ubuntu-latest
    steps:
      - id: pick
        run: echo "go=yes" >> "$GITHUB_OUTPUT"
      - id: node
        if: steps.pick.outputs.go == 'yes'
        uses: actions/setup-node@v4
      - run: echo "\${{ steps.node.outcome }}"
`)
    // A repository variable is set outside the workflow file, so the runner it picks is not known here.
    expect(details(jobOf(repo, "ci.yml:hosted"))).toEqual([
      "hosted picks its runner from fromJSON(vars.FLEET_ONLINE != 'true' && '[\"ubuntu-24.04\"]' || '[\"self-hosted\",\"robot\"]')"
    ])
    const pooled = jobOf(repo, "ci.yml:pooled")
    expect(pooled.runsOn).toBe("self-hosted,pool-\${{ github.retention_days }}")
    // Its runner's name does not say which system it is, so the step reads the system when it starts.
    expect(details(pooled)).toEqual(["pooled picks its runner from pool-\${{ github.retention_days }}"])
    expect(pooled.steps[0]?.command).toBe("echo \${{ runner.os }}")
    expect(outputs(runJob(repo, pooled))).toEqual([process.platform === "darwin" ? "macOS" : "Linux"])
    expect(jobOf(repo, "ci.yml:windows").steps).toEqual([])
    // Whether a setup action ran is not kept: it adds no command of its own.
    expect(details(jobOf(repo, "ci.yml:conditional")).at(-1)).toBe(
      "conditional step 3 depends on steps.node.outcome: how a step ended is known only when its condition is"
    )
  })
})

describe("what the review found", () => {
  // "Workflow syntax: on.<push|pull_request>.branches".
  it("replays a workflow as the event its branch filters let the default branch start", () => {
    const repo = withWorkflow(`
on:
  push: { branches: [main] }
  pull_request: { branches: [develop] }
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - if: github.event_name == 'push'
        run: echo "$GITHUB_EVENT_NAME $GITHUB_REF"
`)
    expect(outputs(runJob(repo, jobOf(repo, "ci.yml:test")))).toEqual(["push refs/heads/main"])
  })

  // On GitHub `if: |` followed by `${{ false }}` holds a line end after the expression, so it is text, and it runs.
  it("runs a step whose condition is an expression with text around it, as GitHub does", () => {
    const repo = withWorkflow(`
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - if: |
          \${{ github.event_name == 'push' }}
        run: echo block
      - if: "\${{ false }} "
        run: echo trailing
      - if: "\${{ '' }}\${{ '' }}"
        run: echo empty
      - id: out
        run: echo "v=" >> "$GITHUB_OUTPUT"
      - if: "\${{ steps.out.outputs.v }}\${{ steps.out.outputs.v }}"
        run: echo decided
`)
    const job = jobOf(repo, "ci.yml:test")
    expect(details(job)).toEqual([
      "test step 3 is left out: ${{ '' }}${{ '' }} is false for a pull request to main"
    ])
    expect(outputs(runJob(repo, job))).toEqual([
      "block",
      "trailing",
      "",
      "smithers-ci: not run, its condition is false"
    ])
  })

  // "Contexts": a context's names are read without case.
  it("reads a matrix key without case, and refuses one whose name is not filled in", () => {
    const repo = withWorkflow(`
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    strategy: { matrix: { os: [linux], "node version": ["18"], node: [{ Version: v20 }] } }
    steps:
      - if: matrix.OS == 'linux'
        run: echo "\${{ matrix.Os }} \${{ matrix.node.version }} [\${{ matrix.absent }}]"
      - run: echo "\${{ matrix['node version'] }}"
`)
    const job = jobOf(repo, "ci.yml:test")
    expect(details(job)).toEqual([
      "test step 2 depends on matrix['node version']: matrix key \"node version\" has a name whose value is not filled in here"
    ])
    const variant = { os: "linux", "node version": "18", "node.Version": "v20" }
    expect(outputs(runJob(repo, job, variant))).toEqual(["linux v20 []"])
  })

  it("does not read a matrix of calls to a workflow as one call", () => {
    const repo = withWorkflow(
      `
on: pull_request
jobs:
  each:
    strategy: { matrix: { os: [linux, mac] } }
    uses: ./.github/workflows/called.yml
    with: { os: "\${{ matrix.os }}" }
`,
      { ".github/workflows/called.yml": "on: { workflow_call: }\njobs: { b: { runs-on: x, steps: [{ run: a }] } }" }
    )
    expect(jobsOf(repo, file).map((job) => job.id)).toEqual(["ci.yml:each"])
    expect(details(jobOf(repo, "ci.yml:each"))).toEqual([
      "./.github/workflows/called.yml is a reusable workflow; its jobs were not read"
    ])
  })

  // "Reusing workflows: Access and permissions".
  it("gives the jobs a job calls the calling job's right to write, and no more than their workflow keeps", () => {
    const called = (permissions: string) =>
      `on: { workflow_call: }\n${permissions}jobs: { b: { runs-on: ubuntu-latest, steps: [{ run: echo b }] } }`
    const repo = withWorkflow(
      `
on: pull_request
jobs:
  writes: { permissions: { contents: write }, uses: ./.github/workflows/plain.yml }
  kept: { permissions: { contents: write, issues: write }, uses: ./.github/workflows/reads.yml }
  narrowed: { permissions: { contents: write }, uses: ./.github/workflows/asks.yml }
  reads: { uses: ./.github/workflows/asks.yml }
`,
      {
        ".github/workflows/plain.yml": called(""),
        ".github/workflows/reads.yml": called("permissions: { contents: read }\n"),
        ".github/workflows/asks.yml": called("permissions: { packages: write }\n")
      }
    )
    const writes = (id: string) =>
      jobOf(repo, id).unsupported.filter((entry) => entry.feature === "write-permission").map((entry) => entry.detail)
    expect(writes("ci.yml:writes/b")).toEqual([".github/workflows/plain.yml: b may write contents"])
    expect(writes("ci.yml:kept/b")).toEqual([])
    expect(writes("ci.yml:narrowed/b")).toEqual([".github/workflows/asks.yml: b may write packages"])
    // A called workflow cannot write what its calling job cannot.
    expect(writes("ci.yml:reads/b")).toEqual([])
  })

  // "on.workflow_call.inputs": `false` for a boolean, `0` for a number and empty for a string given no value.
  it("gives a called workflow's input its type's empty value, and keeps a secret-named value out", () => {
    const repo = withWorkflow(
      `
on: pull_request
jobs:
  call:
    uses: ./.github/workflows/called.yml
    with: { db_password: hunter2 }
`,
      {
        ".github/workflows/called.yml": `
on:
  workflow_call:
    inputs:
      release: { type: boolean }
      count: { type: number }
      note: { type: string }
      db_password: { type: string }
      api_token: { type: string, default: sk-not-a-real-default }
jobs:
  b:
    runs-on: ubuntu-latest
    steps:
      - if: inputs.release == false
        run: echo "[\${{ inputs.release }}][\${{ inputs.count }}][\${{ inputs.note }}]"
      - run: ./login "\${{ inputs.db_password }}"
      - run: ./call "\${{ inputs.api_token }}"
`
      }
    )
    const job = jobOf(repo, "ci.yml:call/b")
    expect(job.steps.map((step) => step.command)).toEqual([`echo "[false][0][]"`])
    expect(details(job)).toEqual([
      "b step 2 depends on secret db_password",
      "b step 3 depends on secret api_token"
    ])
    expect(JSON.stringify(job)).not.toContain("hunter2")
  })

  describe("a local action", () => {
    const action = `
inputs:
  level: { default: none }
  password: { default: "" }
runs:
  using: composite
  steps:
    - shell: bash
      run: echo "LEVEL=two" >> "$GITHUB_ENV"; echo changed > f.txt; pwd
    - shell: bash
      run: echo "\${{ inputs.level }} \${{ inputs.hash }}"
    - shell: bash
      run: ./login "\${{ inputs.password }}"
`

    // "Contexts: inputs": worked out when the action starts, whatever its steps change after.
    it("works its inputs out once, when it starts", () => {
      const repo = withWorkflow(
        `
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: sub } }
    steps:
      - run: echo "LEVEL=one" >> "$GITHUB_ENV"
      - uses: ./act
        with:
          level: \${{ env.LEVEL }}
          hash: \${{ hashFiles('f.txt') }}
          password: hunter2
`,
        { "act/action.yml": action, "f.txt": "first\n", "sub/keep": "" }
      )
      const job = jobOf(repo, "ci.yml:test")
      // A value written out under a name that says it is a secret is kept by name alone, for an input as for a variable.
      expect(details(job)).toEqual(["test step 2 > step 3 depends on secret password"])
      expect(JSON.stringify(job)).not.toContain("hunter2")
      const first = createHash("sha256").update(createHash("sha256").update("first\n").digest()).digest("hex")
      // "Creating a composite action": its steps run in the repository root, whatever the job's `defaults.run` say.
      expect(outputs(runJob(repo, job))).toEqual(["", repo.root, `one ${first}`])
    })

    it("stops reading local actions at a number no workflow needs", () => {
      const fan = "runs: { using: composite, steps: [{ uses: ./fan }, { uses: ./fan }, { uses: ./fan }] }"
      const repo = withWorkflow(
        "on: pull_request\njobs: { test: { runs-on: ubuntu-latest, steps: [{ uses: ./fan }] } }",
        { "fan/action.yml": fan }
      )
      const job = jobOf(repo, "ci.yml:test")
      expect(new Set(details(job))).toEqual(new Set(["./fan has no command to run"]))
      expect(job.steps).toEqual([])
    })
  })

  describe("a setup action", () => {
    // The step's own `env:` is set before its `if:` is read.
    it("reads the condition of a step that uses an action with the step's own variables", () => {
      const workflow = (use: string) => `
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-go@v3
        if: env.USE_JAVA == '1'
        env: { USE_JAVA: ${use} }
      - run: echo "$GOROOT"
`
      // Left out, the action sets nothing, so the script reads whatever the machine has.
      const without = jobOf(withWorkflow(workflow("0")), "ci.yml:test")
      expect(features(without)).toEqual(["condition-false"])
      expect(without.steps.map((step) => step.command)).toEqual([`echo "$GOROOT"`])
      const used = jobOf(withWorkflow(workflow("1")), "ci.yml:test")
      expect(details(used).at(-1)).toBe("test step 2 reads GOROOT, which a setup action sets on GitHub")
      // A runner has a JAVA_HOME anyway: the step is given this machine's (`Inventory.runnerSoftware`).
      const java = jobOf(
        withWorkflow(
          workflow("1").replace("actions/setup-go@v3", "actions/setup-java@v4").replace("$GOROOT", "$JAVA_HOME")
        ),
        "ci.yml:test"
      )
      expect(details(java).filter((detail) => detail.includes("JAVA_HOME"))).toEqual([])
      expect(java.steps.map((step) => step.command)).toEqual([`echo "$JAVA_HOME"`])
      const unread = jobOf(withWorkflow(workflow(`"\${{ github.retention_days }}"`)), "ci.yml:test")
      expect(details(unread)[0]).toBe(
        "test step 1 runs only if env.USE_JAVA == '1': github.retention_days: github.retention_days is known only on GitHub"
      )
    })

    it("refuses a script that reads a variable the action sets on GitHub", () => {
      const repo = withWorkflow(`
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-go@v3
      - run: ls "$GOROOT/bin" "\${GOROOT}"
      - run: echo "$GOROOT_1_22_X64 $MY_GOROOT"
      - env: { GOROOT: /opt/go }
        run: echo "$GOROOT"
`)
      const job = jobOf(repo, "ci.yml:test")
      expect(details(job).at(-1)).toBe("test step 2 reads GOROOT, which a setup action sets on GitHub")
      expect(job.steps.map((step) => step.command)).toEqual([
        `echo "$GOROOT_1_22_X64 $MY_GOROOT"`,
        `echo "$GOROOT"`
      ])
    })

    // An action given a secret does more than put a tool on the machine, such as signing the tool in.
    it("leaves out a job whose setup action receives a secret, and runs what the action also runs", () => {
      const repo = withWorkflow(`
on: pull_request
jobs:
  signed:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with: { token: "\${{ github.token }}", registry-token: "\${{ secrets.NPM_TOKEN }}" }
      - run: echo a
  installs:
    runs-on: ubuntu-latest
    steps:
      - id: pnpm
        if: github.sha != ''
        uses: pnpm/action-setup@v4
        with: { run_install: true }
      - run: echo "\${{ steps.pnpm.outcome }}"
`)
      expect(jobOf(repo, "ci.yml:signed").unsupported.at(-1)).toEqual({
        feature: "secret",
        detail: `${file}: signed step 1: actions/setup-node@v4 receives NPM_TOKEN`
      })
      const installs = jobOf(repo, "ci.yml:installs")
      expect(installs.steps.map((step) => [step.name, step.command])).toEqual([
        ["pnpm/action-setup@v4", "pnpm install"],
        [undefined, `echo "\${{ steps.pnpm.outcome }}"`]
      ])
    })
  })

  it("keeps a step with no id apart from one whose id looks like a place", () => {
    const repo = withWorkflow(`
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - id: _2
        run: echo "x=first" >> "$GITHUB_OUTPUT"
      - run: echo "x=second" >> "$GITHUB_OUTPUT"
      - run: echo "\${{ steps._2.outputs.x }}"
`)
    expect(outputs(runJob(repo, jobOf(repo, "ci.yml:test"))).at(-1)).toBe("first")
  })

  it("reads a workflow with values where text belongs, and never throws", () => {
    const repo = withWorkflow(`
on: pull_request
jobs:
  odd:
    if: { toString: 1 }
    runs-on: ubuntu-latest
    steps:
      - if: { toString: 1 }
        run: echo a
      - if: \${{ ${"(".repeat(5000)}true${")".repeat(5000)} }}
        run: echo b
  looped:
    runs-on: ubuntu-latest
    strategy: { matrix: { include: [ &x { a: *x } ] } }
    steps: [{ run: echo c }]
`)
    expect(jobsOf(repo, file)).toEqual([])
    const safe = withWorkflow(`
on: pull_request
jobs:
  odd:
    if: { toString: 1 }
    runs-on: ubuntu-latest
    steps:
      - if: { toString: 1 }
        run: echo a
      - if: \${{ ${"(".repeat(5000)}true${")".repeat(5000)} }}
        run: echo b
`)
    expect(details(jobOf(safe, "ci.yml:odd"))).toEqual([
      "odd runs only if a value that is not text: it is not text",
      "odd step 1 runs only if a value that is not text: it is not text",
      expect.stringContaining("it nests too deep to read")
    ])
  })

  it("refuses a condition written as text that reads a secret or what only GitHub knows", () => {
    const repo = withWorkflow(`
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - if: "\${{ secrets.DEPLOY }} "
        run: echo a
      - if: "\${{ github.retention_days }} "
        run: echo b
`)
    expect(details(jobOf(repo, "ci.yml:test"))).toEqual([
      "test step 1 runs only if ${{ secrets.DEPLOY }} : it reads secret DEPLOY",
      "test step 2 runs only if ${{ github.retention_days }} : github.retention_days: github.retention_days is known only on GitHub"
    ])
  })

  it("keeps an action's input that a later step could change, however the expression is built", () => {
    const repo = withWorkflow(
      `
on: pull_request
env: { FLAG: "" }
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo "FLAG=set" >> "$GITHUB_ENV"
      - uses: ./act
        with:
          off: \${{ !env.FLAG }}
          text: \${{ format('<{0}>', env.FLAG) }}
          both: \${{ env.FLAG == 'set' && 'yes' || 'no' }}
          fixed: \${{ !github.event.pull_request.draft }}
`,
      {
        "act/action.yml": `
runs:
  using: composite
  steps:
    - shell: bash
      run: echo "FLAG=" >> "$GITHUB_ENV"
    - shell: bash
      run: echo "\${{ inputs.off }} \${{ inputs.text }} \${{ inputs.both }} \${{ inputs.fixed }}"
`
      }
    )
    expect(outputs(runJob(repo, jobOf(repo, "ci.yml:test"))).at(-1)).toBe("false <set> yes true")
  })

  it("reads a list given to a called workflow's input as nothing", () => {
    const repo = withWorkflow(
      "on: pull_request\njobs: { call: { uses: ./.github/workflows/called.yml, with: { list: [a], count: 3 } } }",
      {
        ".github/workflows/called.yml":
          "on: { workflow_call: }\njobs: { b: { runs-on: ubuntu-latest, steps: [{ run: 'echo [${{ inputs.list }}] ${{ inputs.count }}' }] } }"
      }
    )
    expect(jobOf(repo, "ci.yml:call/b").steps.map((step) => step.command)).toEqual(["echo [] 3"])
  })
})

describe("a step that only installs packages", () => {
  // `MachineChanges.withInstalled` leaves such a step out of a replay on a machine that has the packages. The
  // steps around it are written to run the same with it and without it.
  it("has no place among the job's steps, so the job runs the same when it is left out", () => {
    const repo = withWorkflow(`
on: pull_request
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: sudo apt-get update
      - run: echo "MADE=yes" >> "$GITHUB_ENV"
      - run: sudo apt-get install -y zsh
      - run: echo "built $MADE" && echo "NEXT=1" >> "$GITHUB_ENV"
      - run: echo "tested $MADE $NEXT"
  reads:
    runs-on: ubuntu-latest
    steps:
      - id: tools
        run: sudo apt-get install -y zsh
      - if: steps.tools.outcome == 'success'
        run: echo never
  tail:
    runs-on: ubuntu-latest
    steps:
      - run: sudo apt-get install -y git
      - run: echo checked
  head:
    runs-on: ubuntu-latest
    steps:
      - run: echo "A=1" >> "$GITHUB_ENV"
      - run: sudo apt-get install -y git
`)
    const build = jobOf(repo, "ci.yml:build")
    // A sudo that does nothing stands for the machine's.
    const bin = join(repo.temp, "bin")
    mkdirSync(bin)
    writeFileSync(join(bin, "sudo"), `#!/bin/sh\necho "sudo $*"\n`, { mode: 0o755 })
    const path = `${bin}:${process.env["PATH"] ?? ""}`
    expect(outputs(runJob(repo, build, {}, path))).toEqual([
      "sudo apt-get update",
      "",
      "sudo apt-get install -y zsh",
      "built yes",
      "tested yes 1"
    ])
    const without = { ...build, steps: build.steps.filter((step) => installsOf(step.command) === undefined) }
    expect(without.steps).toHaveLength(3)
    expect(outputs(runJob(repo, without))).toEqual(["", "built yes", "tested yes 1"])
    // A job's only other step is written as a job's only step is: it keeps no state for a step after it.
    const tail = jobOf(repo, "ci.yml:tail")
    expect(tail.steps.map((step) => step.runner?.includes("only.XXXXXX"))).toEqual([true, true])
    expect(outputs(runJob(repo, tail, {}, path))).toEqual(["sudo apt-get install -y git", "checked"])
    // With an install step after it, it is read by that step and keeps its state.
    const head = jobOf(repo, "ci.yml:head")
    expect(head.steps.map((step) => step.runner?.includes("only.XXXXXX"))).toEqual([false, true])
    expect(outputs(runJob(repo, head, {}, path))).toEqual(["", "sudo apt-get install -y git"])
    // What such a step gave is not there when it is left out, so nothing may read it.
    expect(details(jobOf(repo, "ci.yml:reads"))).toEqual([
      "reads step 2 runs only if steps.tools.outcome == 'success': what reads step 1 gave: a step that only "
      + "installs packages is left out when they are there"
    ])
  })
})

describe("a first step that asks for the job's temporary directory", () => {
  // "Default environment variables: RUNNER_TEMP". The directory is the job's: every step finds the same one, and
  // no other job does, whether the script names it or an expression reads `runner.temp`.
  it("is its job's alone, and every step of the job has the same directory", () => {
    const repo = withWorkflow(`
on: pull_request
jobs:
  named:
    runs-on: ubuntu-latest
    steps:
      - run: mkdir -p "$RUNNER_TEMP/work" && echo "WORK=$RUNNER_TEMP/work" >> "$GITHUB_ENV"
      - run: echo built > "$WORK/artifact"
      - run: cat "$RUNNER_TEMP/work/artifact"
  other:
    runs-on: ubuntu-latest
    steps:
      - run: mkdir -p "$RUNNER_TEMP/work" && echo "WORK=$RUNNER_TEMP/work" >> "$GITHUB_ENV"
      - run: ls "$WORK" | wc -l | tr -d ' '
  read:
    runs-on: ubuntu-latest
    steps:
      - run: mkdir -p "\${{ runner.temp }}/work"
      - run: ls "$RUNNER_TEMP"
  plain:
    runs-on: ubuntu-latest
    steps:
      - run: echo plain
      - run: echo after
  same:
    runs-on: ubuntu-latest
    steps:
      - run: echo plain
      - run: echo other
`)
    const [named, other, read, plain, same] = ["named", "other", "read", "plain", "same"].map((id) =>
      jobOf(repo, `ci.yml:${id}`)
    ) as [Job, Job, Job, Job, Job]
    // The same script, and still each job's own step.
    expect(named.steps[0]?.command).toBe(other.steps[0]?.command)
    expect(named.steps[0]?.runner).not.toBe(other.steps[0]?.runner)
    expect(outputs(runJob(repo, named))).toEqual(["", "", "built"])
    // `other` finds nothing of what `named` built.
    expect(outputs(runJob(repo, other))).toEqual(["", "0"])
    expect(outputs(runJob(repo, read))).toEqual(["", "work"])
    // A first step that asks for neither is its job's own too.
    expect(plain.steps[0]?.runner).not.toBe(same.steps[0]?.runner)
  })
})

describe("two jobs that start with the same step", () => {
  // Each job has a machine of its own on GitHub, and a runner tells every step its job. So each job runs the step
  // for itself, and its later steps start from what its own run left.
  it("each run it for themselves, and each is told its job", () => {
    const repo = withWorkflow(
      `
on: pull_request
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: sh install.sh
      - run: echo "lint $DEPS $GITHUB_JOB"
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: sh install.sh
      - run: echo "test $DEPS $GITHUB_JOB"
`,
      { "install.sh": "echo \"DEPS=ready\" >> \"$GITHUB_ENV\"\necho \"job=$GITHUB_JOB\"\n" }
    )
    const [lint, test] = ["lint", "test"].map((id) => jobOf(repo, `ci.yml:${id}`)) as [Job, Job]
    expect(lint.steps[0]?.command).toBe(test.steps[0]?.command)
    expect(lint.steps[0]?.runner).not.toBe(test.steps[0]?.runner)
    expect(outputs(runJob(repo, lint))).toEqual(["job=lint", "lint ready lint"])
    expect(outputs(runJob(repo, test))).toEqual(["job=test", "test ready test"])
  })

  // Nothing reads what the only step of a job leaves. It is written to leave nothing and to look at no state but
  // its own, so a result kept from what it read stays good whatever other jobs leave beside it.
  it("do not share it with a job that has no other step", () => {
    const repo = withWorkflow(
      `
on: pull_request
jobs:
  only:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: sh install.sh
  more:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: sh install.sh
      - run: echo "more $DEPS"
`,
      { "install.sh": "echo \"DEPS=ready\" >> \"$GITHUB_ENV\"\necho \"job=${1-none}\"\n" }
    )
    const [only, more] = ["only", "more"].map((id) => jobOf(repo, `ci.yml:${id}`)) as [Job, Job]
    expect(only.steps).toHaveLength(1)
    expect(only.steps[0]?.command).toBe(more.steps[0]?.command)
    expect(only.steps[0]?.runner).not.toBe(more.steps[0]?.runner)
    const [first, second] = more.steps as [Job["steps"][number], Job["steps"][number]]
    // `only` runs between the two steps of `more` and takes nothing of what the first one left.
    expect(outputs(runJob(repo, { ...more, steps: [first] }))).toEqual(["job=none"])
    expect(outputs(runJob(repo, only))).toEqual(["job=none"])
    expect(outputs(runJob(repo, { ...more, steps: [second] }))).toEqual(["more ready"])
  })
})

// "Variables reference: Default environment variables": a runner sets them for every step, whatever the step runs.
describe("the variables a runner gives", () => {
  // The script names no variable. A program it starts reads them from its own code, as a test does.
  const show = [
    "const mine = Object.entries(process.env).filter(([name]) => /^(?:CI$|GITHUB_|RUNNER_)/.test(name))",
    "console.log(JSON.stringify(Object.fromEntries(mine)))",
    ""
  ].join("\n")

  it("gives every step every default variable, with no token, whatever its script names", () => {
    const repo = withWorkflow(
      `
name: Checks
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: node show.js
      - id: again
        run: node show.js
`,
      { "show.js": show }
    )
    const { head, parent } = commits(repo)
    const job = jobOf(repo, "ci.yml:test")
    expect(job.unsupported).toEqual([])
    const ran = runJob(repo, job)
    expect(ran.map((step) => step.status)).toEqual([0, 0])
    const [first, again] = ran.map((step) => JSON.parse(step.output) as Record<string, string>) as [
      Record<string, string>,
      Record<string, string>
    ]
    // Everything in GitHub's table but what a runner itself leaves unset for a script step outside an action.
    const given = githubDefaultVariables.filter((name) => !["unset", "action"].includes(String(defaultVariables[name])))
    for (const seen of [first, again]) {
      expect(Object.keys(seen).filter((name) => name !== "GITHUB_STATE").sort()).toEqual([...given].sort())
      expect(Object.keys(seen).filter((name) => /TOKEN|^ACTIONS_/.test(name))).toEqual([])
    }
    expect(first).toMatchObject({
      CI: "true",
      GITHUB_ACTIONS: "true",
      GITHUB_ACTION: "__run",
      GITHUB_ACTOR: "smithers-ci",
      GITHUB_BASE_REF: "main",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_HEAD_REF: "smithers-ci",
      GITHUB_JOB: "test",
      GITHUB_REF: "refs/pull/1/merge",
      GITHUB_REF_NAME: "1/merge",
      GITHUB_REPOSITORY: "acme/widgets",
      GITHUB_REPOSITORY_OWNER: "acme",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_RUN_ID: String(10_000_000_000 + Number.parseInt(head.slice(0, 9), 16)),
      GITHUB_RUN_NUMBER: "2",
      GITHUB_SHA: head,
      GITHUB_WORKFLOW: "Checks",
      GITHUB_WORKFLOW_REF: "acme/widgets/.github/workflows/ci.yml@refs/pull/1/merge",
      GITHUB_WORKFLOW_SHA: head,
      GITHUB_WORKSPACE: repo.root,
      RUNNER_ENVIRONMENT: "self-hosted",
      RUNNER_NAME: "smithers-ci"
    })
    expect(again["GITHUB_ACTION"]).toBe("again")
    expect(again["GITHUB_SHA"]).toBe(head)
    // The event file is a real file, and each step's own files are its own.
    expect(JSON.parse(readFileSync(String(again["GITHUB_EVENT_PATH"]), "utf8"))).toMatchObject({
      pull_request: { head: { sha: head }, base: { sha: parent } }
    })
    expect(again["GITHUB_ENV"]).not.toBe(first["GITHUB_ENV"])
  })

  // "Default environment variables: GITHUB_ACTION": `__run` for a script with no id, with its place after the first.
  it("names a script with no id by its place", () => {
    const repo = withWorkflow(
      `
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: node show.js
`,
      { "show.js": show }
    )
    const [ran] = runJob(repo, jobOf(repo, "ci.yml:test"))
    expect(JSON.parse(ran?.output ?? "")).toMatchObject({
      GITHUB_ACTION: "__run_2",
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/heads/main",
      GITHUB_HEAD_REF: "",
      GITHUB_WORKFLOW: ".github/workflows/ci.yml"
    })
  })
})

// "Workflow syntax: jobs.<job_id>.steps[*].timeout-minutes": "The maximum number of minutes to run the step before
// killing the process. Fractional values are not supported. `timeout-minutes` must be a positive integer."
// "Workflow syntax: jobs.<job_id>.timeout-minutes": "The maximum number of minutes to let a job run before GitHub
// automatically cancels it."
describe("a step's time limit", () => {
  const limits = (job: Job) =>
    job.steps.map((step) => /__limit=(\d+); __allowed='([^']+)'/.exec(String(step.runner))?.slice(1, 3))

  it("holds a step to its timeout-minutes, and to its job's when that is less", () => {
    const repo = withWorkflow(
      `
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - run: echo one
      - timeout-minutes: 3
        run: echo two
      - timeout-minutes: \${{ 30 }}
        run: echo three
      - uses: ./.github/actions/both
        timeout-minutes: 2
      - uses: ./.github/actions/both
  free:
    runs-on: ubuntu-latest
    steps:
      - run: echo free
      - timeout-minutes: 1
        run: echo held
      - timeout-minutes: 400
        run: echo long
`,
      {
        ".github/actions/both/action.yml":
          "runs:\n  using: composite\n  steps:\n    - run: echo four\n      shell: bash\n    - run: echo five\n      shell: bash\n"
      }
    )
    const job = jobOf(repo, "ci.yml:test")
    expect(job.unsupported).toEqual([])
    // A step of an action is held to the limit of the step that uses the action.
    expect(limits(job)).toEqual([
      ["1200", "20 minutes"],
      ["180", "3 minutes"],
      ["1200", "20 minutes"],
      ["120", "2 minutes"],
      ["120", "2 minutes"],
      ["1200", "20 minutes"],
      ["1200", "20 minutes"]
    ])
    expect(outputs(runJob(repo, job))).toEqual(["one", "two", "three", "four", "five", "four", "five"])
    const free = jobOf(repo, "ci.yml:free")
    // Any step is stopped after six hours, so a longer limit adds nothing.
    expect(limits(free)).toEqual([undefined, ["60", "1 minute"], undefined])
    expect(outputs(runJob(repo, free))).toEqual(["free", "held", "long"])
  })

  it.each<[string, string, string, string]>([
    ["a job's fraction", "timeout-minutes: 1.5", "", "test has a timeout-minutes a replay cannot keep: 1.5 is not"],
    ["a step's zero", "", "timeout-minutes: 0", "step 1 has a timeout-minutes a replay cannot keep: 0 is not"],
    ["a step's text", "", "timeout-minutes: '10'", "a replay cannot keep: text is not a number of minutes"],
    [
      "a step's matrix value",
      "",
      "timeout-minutes: ${{ matrix.minutes }}",
      "a replay cannot keep: matrix.minutes is decided while the job runs"
    ],
    ["a job's secret", "timeout-minutes: ${{ secrets.LIMIT }}", "", "a replay cannot keep: it comes from secret LIMIT"]
  ])("leaves a job out over %s: no limit is guessed", (_name, ofJob, ofStep, reason) => {
    const repo = withWorkflow(`
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    ${ofJob}
    strategy:
      matrix:
        minutes: [5, 10]
    steps:
      - run: echo one
        ${ofStep}
`)
    const job = jobOf(repo, "ci.yml:test")
    expect(features(job)).toEqual(["expression"])
    expect(job.unsupported[0]?.detail).toContain(reason)
  })
})

// A step that runs again without the steps before it, because their results were reused, starts from the job's
// state as an earlier run left it. It reads what the steps before it wrote, never what a step after it left there.
describe("a step that runs again after a whole run of its job", () => {
  const workflow = `
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo "FIRST=1" >> "$GITHUB_ENV"
      - run: echo "SECOND=2" >> "$GITHUB_ENV"
      - id: early
        run: |
          echo "[\${FIRST-}] [\${SECOND-}] [\${LATE-unset}] [\${{ env.LATE }}] \${PATH%%:*}"
          echo "seen=\${LATE-unset}" >> "$GITHUB_OUTPUT"
      - id: late
        run: |
          if [ ! -f quiet ]; then
            echo "LATE=3" >> "$GITHUB_ENV"
            echo "/opt/late" >> "$GITHUB_PATH"
            echo "said=yes" >> "$GITHUB_OUTPUT"
          fi
      - run: echo "[\${LATE-unset}] [\${{ env.LATE }}] [\${{ steps.late.outputs.said }}] [\${{ steps.early.outputs.seen }}] \${PATH%%:*}"
`

  it("reads what the steps before it wrote, and nothing a later step left on the earlier run", () => {
    const repo = withWorkflow(workflow)
    const job = jobOf(repo, "ci.yml:test")
    expect(job.unsupported).toEqual([])
    // The first place on PATH, which a step finds there until a step before it writes to GITHUB_PATH.
    const first = "/smithers-ci-test/bin"
    const path = `${first}:${process.env["PATH"] ?? ""}`
    const whole = outputs(runJob(repo, job, {}, path))
    expect(whole.slice(2)).toEqual([`[1] [2] [unset] [] ${first}`, "", "[3] [3] [yes] [unset] /opt/late"])
    // The third step runs again: the two before it are not run, and what the fourth left is still in the state.
    const again = outputs(runJob(repo, { ...job, steps: job.steps.slice(2) }, {}, path))
    expect(again).toEqual([`[1] [2] [unset] [] ${first}`, "", "[3] [3] [yes] [unset] /opt/late"])
  })

  it("starts each step with nothing of what that step left before", () => {
    const repo = withWorkflow(workflow)
    const job = jobOf(repo, "ci.yml:test")
    runJob(repo, job)
    // This time the fourth step writes nothing, so the fifth is given nothing by it.
    writeFileSync(join(repo.root, "quiet"), "")
    const again = outputs(runJob(repo, { ...job, steps: job.steps.slice(3) }))
    expect(again[1]?.startsWith("[unset] [] [] [unset] ")).toBe(true)
    expect(again[1]).not.toContain("/opt/late")
  })

  it("gives a step the keys of the steps before it, a local action's own steps among them", () => {
    const repo = withWorkflow(
      `
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - id: one
        run: echo one
      - id: two
        uses: ./.github/actions/both
      - run: sudo apt-get install -y zsh
      - run: echo last
`,
      {
        ".github/actions/both/action.yml":
          "runs:\n  using: composite\n  steps:\n    - id: a\n      run: echo a\n      shell: bash\n    - run: echo b\n      shell: bash\n"
      }
    )
    const before = jobOf(repo, "ci.yml:test").steps.map((step) =>
      /^__before='([^']*)'$/m.exec(String(step.runner))?.[1]
    )
    // A step that only installs packages reads what the steps before it left, and leaves nothing to read.
    expect(before).toEqual(["", "ONE", "ONE TWO.A", "ONE TWO.A TWO.-2", "ONE TWO.A TWO.-2"])
  })
})
