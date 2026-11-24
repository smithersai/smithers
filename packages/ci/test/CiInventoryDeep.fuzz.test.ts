import * as NodeServices from "@effect/platform-node/NodeServices"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, FileSystem, Path, Schema } from "effect"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { describe, expect, it } from "vitest"
import { type Host, type Inventory, type Job } from "../src/contract/Inventory.vibe"
import * as Actions from "../src/inventory/Actions.vibe"
import * as Contexts from "../src/inventory/Contexts.vibe"
import * as Expression from "../src/inventory/Expression.ts"
import * as GithubActions from "../src/inventory/GithubActions.vibe"
import * as Justfile from "../src/inventory/Justfile.vibe"
import * as LeftRunning from "../src/inventory/LeftRunning.vibe"
import * as Machine from "../src/inventory/Machine.vibe"
import * as MachineChanges from "../src/inventory/MachineChanges.vibe"
import * as Makefile from "../src/inventory/Makefile.vibe"
import * as PackageJson from "../src/inventory/PackageJson.vibe"
import * as Read from "../src/inventory/Read.vibe"
import * as Runner from "../src/inventory/Runner.ts"
import * as Setup from "../src/inventory/Setup.vibe"
import * as SetupCache from "../src/inventory/SetupCache.vibe"
import * as Tools from "../src/inventory/Tools.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "100"))
const fsExecutions = Math.min(executions, 12)
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261124")

const makeJob = (commands: ReadonlyArray<string>, fields: Partial<Job> = {}): Job => ({
  id: "ci.yml:build",
  source: "github-actions",
  file: ".github/workflows/ci.yml",
  name: "build",
  needs: [],
  triggers: ["push"],
  matrix: [],
  runsOn: "ubuntu-latest",
  steps: commands.map((command, index) => ({
    id: `ci.yml:build:${index + 1}`,
    ...(index % 2 === 0 ? { name: `step-${index}` } : {}),
    command,
    cwd: "",
    env: {},
    secrets: []
  })),
  unsupported: [],
  ...fields
})

describe("@smthrs/ci inventory deep fuzz invariants", () => {
  it("GithubActions.readWorkflow exercises workflows with matrices, triggers, services, containers, caches, setups, reusable & composite actions", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        triggerKind: Schema.Literals([
          "push",
          "array",
          "filtered",
          "release-tag",
          "merge-group",
          "dispatch-inputs",
          "pull-request-target",
          "empty"
        ]),
        runnerKind: Schema.Literals([
          "ubuntu-latest",
          "macos-latest",
          "windows-latest",
          "self-hosted-array",
          "matrix-os",
          "group-object"
        ]),
        setupKind: Schema.Literals([
          "checkout-basic",
          "checkout-submodules",
          "checkout-ref",
          "setup-node",
          "setup-python",
          "setup-go",
          "setup-bun",
          "setup-zig",
          "setup-java",
          "rust-toolchain",
          "setup-ruby",
          "cache-v4",
          "cache-restore",
          "cache-save",
          "local-action",
          "unknown-action",
          "docker-action"
        ]),
        shellKind: Schema.Literals(["default", "bash", "sh", "pwsh", "python", "custom"]),
        hasContainer: Schema.Boolean,
        hasServices: Schema.Boolean,
        hasMatrixIncludeExclude: Schema.Boolean,
        hasReusableJob: Schema.Boolean,
        hasTimeout: Schema.Boolean,
        hasContinueOnError: Schema.Boolean,
        hasConcurrency: Schema.Boolean,
        hasPermissions: Schema.Boolean,
        hasJobIf: Schema.Boolean,
        hasStepIf: Schema.Boolean,
        defaultBranch: Schema.Literals(["main", "develop", "master"]),
        secretName: Schema.Literals(["NPM_TOKEN", "TURBO_TOKEN", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (c) =>
          Effect.sync(() => {
            const onYaml = c.triggerKind === "push"
              ? "on: push"
              : c.triggerKind === "array"
              ? "on: [push, pull_request]"
              : c.triggerKind === "filtered"
              ? `on:\n  push:\n    branches: [${c.defaultBranch}]\n    paths-ignore: [docs/**]\n  pull_request:\n    types: [opened, synchronize]\n    paths: ['src/**']`
              : c.triggerKind === "release-tag"
              ? `on:\n  push:\n    tags: ['v*']\n  workflow_dispatch:`
              : c.triggerKind === "merge-group"
              ? "on:\n  merge_group:\n    types: [checks_requested]"
              : c.triggerKind === "dispatch-inputs"
              ? `on:\n  workflow_dispatch:\n    inputs:\n      env:\n        type: choice\n        default: staging\n        options: [staging, prod]`
              : c.triggerKind === "pull-request-target"
              ? "on:\n  pull_request_target:\n    branches: [main]"
              : ""

            const runsOnYaml = c.runnerKind === "ubuntu-latest"
              ? "ubuntu-latest"
              : c.runnerKind === "macos-latest"
              ? "macos-latest"
              : c.runnerKind === "windows-latest"
              ? "windows-latest"
              : c.runnerKind === "self-hosted-array"
              ? "[self-hosted, linux, x64]"
              : c.runnerKind === "matrix-os"
              ? "${{ matrix.os }}"
              : "{ group: big-runners, labels: [ubuntu-latest] }"

            const setupStep = c.setupKind === "checkout-basic"
              ? `      - uses: actions/checkout@v4`
              : c.setupKind === "checkout-submodules"
              ? `      - uses: actions/checkout@v4\n        with:\n          submodules: recursive\n          fetch-depth: 0\n          lfs: true\n          path: sub`
              : c.setupKind === "checkout-ref"
              ? `      - uses: actions/checkout@v4\n        with:\n          repository: other/repo\n          ref: v1.0.0\n          token: \${{ secrets.${c.secretName} }}`
              : c.setupKind === "setup-node"
              ? `      - uses: actions/setup-node@v4\n        with:\n          node-version: "22"\n          cache: pnpm`
              : c.setupKind === "setup-python"
              ? `      - uses: actions/setup-python@v5\n        with:\n          python-version: "3.12"\n          cache: pip`
              : c.setupKind === "setup-go"
              ? `      - uses: actions/setup-go@v5\n        with:\n          go-version: "1.23"\n          cache: true`
              : c.setupKind === "setup-bun"
              ? `      - uses: oven-sh/setup-bun@v2\n        with:\n          bun-version: "1.3.0"`
              : c.setupKind === "setup-zig"
              ? `      - uses: mlugg/setup-zig@v2\n        with:\n          version: "0.14.0"`
              : c.setupKind === "setup-java"
              ? `      - uses: actions/setup-java@v4\n        with:\n          distribution: temurin\n          java-version: "21"\n          cache: gradle`
              : c.setupKind === "rust-toolchain"
              ? `      - uses: dtolnay/rust-toolchain@stable\n        with:\n          components: clippy, rustfmt`
              : c.setupKind === "setup-ruby"
              ? `      - uses: ruby/setup-ruby@v1\n        with:\n          ruby-version: "3.3"\n          bundler-cache: true`
              : c.setupKind === "cache-v4"
              ? `      - id: cache\n        uses: actions/cache@v4\n        with:\n          path: |\n            ~/.cache\n            node_modules\n          key: \${{ runner.os }}-deps-\${{ hashFiles('**/pnpm-lock.yaml') }}\n          restore-keys: |\n            \${{ runner.os }}-deps-`
              : c.setupKind === "cache-restore"
              ? `      - uses: actions/cache/restore@v4\n        with:\n          path: .cache\n          key: k-1`
              : c.setupKind === "cache-save"
              ? `      - uses: actions/cache/save@v4\n        with:\n          path: .cache\n          key: k-1`
              : c.setupKind === "local-action"
              ? `      - uses: ./.github/actions/prep\n        with:\n          mode: fast`
              : c.setupKind === "unknown-action"
              ? `      - uses: codecov/codecov-action@v4\n        with:\n          token: \${{ secrets.${c.secretName} }}`
              : `      - uses: docker://alpine:3.19\n        with:\n          args: echo hi`

            const shellLine = c.shellKind === "default"
              ? ""
              : c.shellKind === "custom"
              ? "        shell: custom-sh {0}"
              : `        shell: ${c.shellKind}`

            const yaml = [
              "name: Fuzz CI",
              onYaml,
              c.hasConcurrency ? "concurrency:\n  group: ci-${{ github.ref }}\n  cancel-in-progress: true" : "",
              c.hasPermissions ? "permissions:\n  contents: read\n  id-token: write" : "",
              "env:",
              "  WF_VAR: hello",
              "  TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}",
              "defaults:",
              "  run:",
              "    working-directory: packages/app",
              "jobs:",
              "  prep:",
              "    runs-on: ubuntu-latest",
              "    outputs:",
              "      sha: ${{ steps.id1.outputs.sha }}",
              "    steps:",
              "      - id: id1",
              "        run: echo \"sha=$GITHUB_SHA\" >> \"$GITHUB_OUTPUT\"",
              "  main:",
              "    needs: [prep]",
              `    runs-on: ${runsOnYaml}`,
              c.hasJobIf
                ? "    if: github.event_name == 'push' && !contains(github.event.head_commit.message, '[skip ci]')"
                : "",
              c.hasTimeout ? "    timeout-minutes: 15" : "",
              c.hasContinueOnError ? "    continue-on-error: true" : "",
              c.hasContainer ? "    container:\n      image: node:22-bookworm\n      env:\n        NODE_ENV: test" : "",
              c.hasServices
                ? "    services:\n      postgres:\n        image: postgres:16\n        ports: ['5432:5432']"
                : "",
              c.hasMatrixIncludeExclude
                ? [
                  "    strategy:",
                  "      fail-fast: false",
                  "      max-parallel: 2",
                  "      matrix:",
                  "        os: [ubuntu-latest, macos-latest]",
                  "        node: [20, 22]",
                  "        include:",
                  "          - os: ubuntu-latest",
                  "            node: 22",
                  "            extra: yes",
                  "        exclude:",
                  "          - os: macos-latest",
                  "            node: 20"
                ].join("\n")
                : c.runnerKind === "matrix-os"
                ? "    strategy:\n      matrix:\n        os: [ubuntu-latest, macos-latest]"
                : "",
              "    env:",
              "      JOB_ENV: ${{ vars.MODE || 'default' }}",
              "    steps:",
              setupStep,
              "      - name: Build & Test",
              "        id: build",
              c.hasStepIf ? "        if: steps.cache.outputs.cache-hit != 'true' && success()" : "",
              c.hasTimeout ? "        timeout-minutes: 5" : "",
              c.hasContinueOnError ? "        continue-on-error: true" : "",
              shellLine,
              "        working-directory: ${{ matrix.os == 'ubuntu-latest' && 'pkg' || '.' }}",
              "        env:",
              `          TOK: \${{ secrets.${c.secretName} }}`,
              "          REF: ${{ github.ref_name }}",
              "          PREP_SHA: ${{ needs.prep.outputs.sha }}",
              "        run: |",
              "          echo \"sha=${{ github.sha }} run=${{ github.run_id }}\"",
              "          pnpm test",
              c.hasReusableJob
                ? "  reusable:\n    uses: ./.github/workflows/sub.yml\n    with:\n      target: all\n    secrets: inherit"
                : ""
            ]
              .filter((line) => line.length > 0)
              .join("\n")

            const parsed = GithubActions.readWorkflow(".github/workflows/ci.yml", yaml, {
              repository: "acme/widgets",
              defaultBranch: c.defaultBranch
            })

            const parsed2 = GithubActions.readWorkflow(".github/workflows/ci.yml", yaml, {
              repository: "acme/widgets",
              defaultBranch: c.defaultBranch
            })
            return Array.isArray(parsed.jobs) && Array.isArray(parsed2.jobs) && parsed.jobs.length >= 2
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("MachineChanges exercises changesIn, startedIn, listed, markChanges, questionFor, answers, installsOf, questionsFor, withInstalled", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        cmd: Schema.Literals([
          "sudo apt-get update && sudo apt-get install -y jq ripgrep build-essential",
          "sudo apt install --no-install-recommends curl git",
          "brew install zig hyperfine",
          "brew tap oven-sh/tap && brew install bun",
          "pip install pytest ruff",
          "pip3 install --user black",
          "uv tool install ruff",
          "cargo install cargo-nextest --locked",
          "npm install -g typescript pnpm",
          "pnpm add -g turbo",
          "bun add -g @biomejs/biome",
          "go install golang.org/x/tools/gopls@latest",
          "rustup component add clippy rustfmt",
          "rustup target add wasm32-unknown-unknown",
          "sudo dnf install -y gcc",
          "sudo yum install -y make",
          "apk add --no-cache bash curl",
          "pacman -S --noconfirm git",
          "sudo systemctl start postgresql",
          "sudo service redis-server start",
          "doas -u root reboot",
          "su -c 'make install'",
          "curl -fsSL https://example.test/install.sh | bash",
          "wget -qO- https://example.test/install.sh | sh",
          "bash -c 'sudo chmod 755 /usr/local/bin/tool'",
          "env FOO=1 timeout -k 5 10 nice -n 5 sudo make install",
          "xargs -I {} sudo rm -rf {}",
          "find . -name '*.tmp' -exec sudo rm {} ;",
          "if true; then sudo ls; fi",
          "while false; do sudo ls; done",
          "case x in a) sudo ls ;; esac",
          "echo $(sudo id) && echo `sudo whoami`",
          "dockerd &",
          "pnpm test && cargo test"
        ]),
        manager: Schema.Literals([
          "apt",
          "apt-get",
          "brew",
          "pip",
          "pip3",
          "cargo",
          "npm",
          "pnpm",
          "bun",
          "go",
          "rustup",
          "apk",
          "dnf",
          "yum",
          "pacman",
          "uv",
          "unknown"
        ]),
        pkgName: Schema.Literals([
          "jq",
          "ripgrep",
          "git",
          "python3",
          "zig",
          "clippy",
          "wasm32-unknown-unknown",
          "libssl-dev",
          "pkg-config"
        ]),
        probeOutput: Schema.Literals([
          "",
          "ii  jq 1.7\n",
          "/usr/bin/jq\n",
          "clippy-x86_64-unknown-linux-gnu (installed)\n",
          "not found\n"
        ]),
        listLen: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 6 })))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ cmd, manager, pkgName, probeOutput, listLen }) =>
          Effect.sync(() => {
            const changes = MachineChanges.changesIn(cmd, { CI: "true" })
            const started = MachineChanges.startedIn(cmd, { CI: "true" })
            const installs = MachineChanges.installsOf(cmd)
            const marked = MachineChanges.markChanges(makeJob([cmd]))
            const inv: Inventory = {
              version: 1,
              repository: "acme/r",
              commit: "0".repeat(40),
              toolchains: [],
              jobs: [marked]
            }
            const qs = MachineChanges.questionsFor(inv, () => true)
            const q = MachineChanges.questionFor(manager, pkgName)
            if (q !== undefined) {
              const ans = MachineChanges.answers(q, probeOutput)
              if (typeof ans !== "boolean") return false
            }
            const present = new Set<string>(qs.slice(0, 1).map((x) => `${x.manager}:${x.name}`))
            const updated = MachineChanges.withInstalled(inv, () => true, (m, n) => present.has(`${m}:${n}`))
            const names = Array.from({ length: listLen }, (_, i) => `item-${i}`)
            const listStr = MachineChanges.listed(names)
            return (
              Array.isArray(changes) &&
              Array.isArray(started) &&
              (installs === undefined || Array.isArray(installs)) &&
              Array.isArray(updated.jobs) &&
              typeof listStr === "string"
            )
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("LeftRunning exercises leftRunningIn, stepName, markLeftRunning on daemon, background & foreground scripts", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        cmd: Schema.Literals([
          "python3 -m http.server 8767 --bind 127.0.0.1 > /dev/null 2>&1 &",
          "npm start &",
          "( cd api && server & )",
          "first & second & wait %1",
          "first & second & wait $!",
          "first & wait 12345",
          "first & wait",
          "nohup ./bin/server --port 3000 > server.log 2>&1 &",
          "PORT=3000 node server.js &\nsleep 1",
          "Xvfb :99 & echo started",
          "redis-server --daemonize yes",
          "redis-server --port 6380 --daemonize=yes",
          "valkey-server --daemonize yes",
          "mongod --fork --logpath /tmp/m.log",
          "memcached -d -p 11211",
          "memcached --daemon",
          "start-stop-daemon -S -x /usr/bin/app",
          "setsid --fork ./serve",
          "setsid -f ./serve",
          "pg_ctl -D data start",
          "sudo pg_ctlcluster 16 main start",
          "daemonize /usr/bin/app",
          "eval \"$(ssh-agent -s)\"",
          "docker compose up -d",
          "make test && make lint",
          "echo 'foo & bar' && echo \"baz &\"",
          "cmd 2>&1 | tee log"
        ]),
        hasName: Schema.Boolean,
        extra: Schema.String.pipe(Schema.check(Schema.isMaxLength(40)))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ cmd, hasName, extra }) =>
          Effect.sync(() => {
            const left = LeftRunning.leftRunningIn(cmd, { CI: "true" })
            LeftRunning.leftRunningIn(extra)
            const j = makeJob([cmd], {
              steps: [
                {
                  id: "ci.yml:build:1",
                  ...(hasName ? { name: "Start Server" } : {}),
                  command: cmd,
                  cwd: "",
                  env: {},
                  secrets: []
                }
              ]
            })
            const sn = LeftRunning.stepName(j.steps[0]!)
            const marked = LeftRunning.markLeftRunning(j)
            return Array.isArray(left) && typeof sn === "string" && sn.length > 0 && marked.steps.length === 1
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Runner.write exercises all JobFacts, StepFacts, residual expression kinds, shells, conditions, keeps & env exports", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        exprKind: Schema.Literals([
          "literal-str",
          "literal-num",
          "literal-bool",
          "literal-null",
          "matrix-var",
          "step-output",
          "env-var",
          "binary-eq",
          "binary-and",
          "binary-or",
          "binary-lt",
          "unary-not",
          "call-contains",
          "call-startsWith",
          "call-endsWith",
          "call-format",
          "call-join",
          "call-toJSON",
          "call-fromJSON",
          "call-hashFiles",
          "index-prop",
          "status-success",
          "status-failure",
          "status-always",
          "status-cancelled"
        ]),
        second: Schema.Boolean,
        apart: Schema.Boolean,
        hasJob: Schema.Boolean,
        hasAfter: Schema.Boolean,
        hasDir: Schema.Boolean,
        hasCondition: Schema.Boolean,
        commit: Schema.Boolean,
        ownCi: Schema.Boolean,
        store: Schema.Boolean,
        python: Schema.Boolean,
        hasLimit: Schema.Boolean,
        badMatrixKey: Schema.Boolean,
        shell: Schema.Literals(["bash", "sh", "python"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (c) =>
          Effect.sync(() => {
            const scope: Expression.Scope = {
              context: (name) => {
                if (name === "matrix") return Expression.variable("m", "matrix", false, true)
                if (name === "steps") return Expression.variable("s", "steps", false, false)
                if (name === "env") return Expression.variable("e", "env", false, false)
                if (name === "github") {
                  return Contexts.github("pull_request", { repository: "a/b", defaultBranch: "main" }, {
                    job: "build",
                    workflow: "CI"
                  })
                }
                if (name === "runner") return Contexts.runner("linux")
                return undefined
              }
            }
            const exprText = c.exprKind === "literal-str" ?
              "'hello'"
              : c.exprKind === "literal-num" ?
              "42"
              : c.exprKind === "literal-bool" ?
              "true"
              : c.exprKind === "literal-null" ?
              "null"
              : c.exprKind === "matrix-var" ?
              "matrix.os"
              : c.exprKind === "step-output" ?
              "steps.s1.outputs.out"
              : c.exprKind === "env-var" ?
              "env.FOO"
              : c.exprKind === "binary-eq" ?
              "matrix.os == 'ubuntu-latest'"
              : c.exprKind === "binary-and" ?
              "matrix.os == 'ubuntu-latest' && env.FOO != ''"
              : c.exprKind === "binary-or" ?
              "env.FOO || 'fallback'"
              : c.exprKind === "binary-lt" ?
              "matrix.num < 10"
              : c.exprKind === "unary-not" ?
              "!env.SKIP"
              : c.exprKind === "call-contains" ?
              "contains(matrix.os, 'ubuntu')"
              : c.exprKind === "call-startsWith" ?
              "startsWith(matrix.os, 'ubuntu')"
              : c.exprKind === "call-endsWith" ?
              "endsWith(matrix.os, 'latest')"
              : c.exprKind === "call-format" ?
              "format('{0}-{1}', matrix.os, env.FOO)"
              : c.exprKind === "call-join" ?
              "join(matrix.tags, ',')"
              : c.exprKind === "call-toJSON" ?
              "toJSON(matrix)"
              : c.exprKind === "call-fromJSON" ?
              "fromJSON('{\"k\":1}').k"
              : c.exprKind === "call-hashFiles" ?
              "hashFiles('package.json')"
              : c.exprKind === "index-prop" ?
              "matrix['os']"
              : c.exprKind === "status-success" ?
              "success()"
              : c.exprKind === "status-failure" ?
              "failure()"
              : c.exprKind === "status-always" ?
              "always()"
              : "cancelled()"

            const evaluated = Expression.evaluate(exprText, scope)
            const residual: Expression.Residual = evaluated.kind === "ok"
              ? evaluated.residual
              : { kind: "literal", value: "fallback" }

            const isText = Runner.isTextResult(residual)
            const isSettled = Runner.settled(residual)
            const quoted = Runner.quote(`hello 'world' ${exprText}`)

            const jobFacts: Runner.JobFacts = {
              id: "ci.yml:build",
              matrixKeys: c.badMatrixKey ? ["bad key!"] : ["os", "num"],
              variants: [{ os: "ubuntu-latest", num: "5" }],
              typedVariants: [{ os: "ubuntu-latest", num: 5 }],
              variables: Contexts.variables("pull_request", { repository: "a/b", defaultBranch: "main" }, {
                job: "build",
                workflow: "CI"
              }),
              standIns: Contexts.standIns("pull_request", { repository: "a/b", defaultBranch: "main" }, {
                job: "build",
                workflow: "CI"
              }),
              event: Contexts.eventFile("pull_request", { repository: "a/b", defaultBranch: "main" }),
              eventName: "pull_request"
            }

            const stepFacts: Runner.StepFacts = {
              key: "STEP_2",
              after: c.hasAfter ? "MARK_1" : undefined,
              second: c.second,
              apart: c.apart,
              job: c.hasJob ? "build" : undefined,
              before: c.hasAfter ? ["STEP_1"] : [],
              cwd: "packages/app",
              directory: c.hasDir ? ["sub/", { residual, written: "x" }] : undefined,
              start: c.shell === "python" ? ["python3", "-c"] : [c.shell, "-e", "-c"],
              own: ["OWN_VAR"],
              keeps: [["KEEP_A", ["val-", { residual, written: "x" }]]],
              condition: c.hasCondition ? residual : undefined,
              outer: [["OUTER_A", [{ residual, written: "x" }]]],
              env: [["STEP_A", ["prefix-", { residual, written: "x" }]]],
              fills: [["${{ FILL }}", residual]],
              commit: c.commit,
              ownCi: c.ownCi,
              ownQuiet: c.ownCi ? ["DO_NOT_TRACK"] : [],
              action: "step_action",
              limit: c.hasLimit ? 30 : undefined,
              store: c.store,
              python: c.python
            }

            const written = Runner.write(jobFacts, stepFacts, "echo ${{ FILL }}")
            if (c.badMatrixKey) return "problem" in written
            return typeof isText === "boolean" && (isSettled === undefined || typeof isSettled === "boolean") &&
              quoted.startsWith("'") && ("text" in written || "problem" in written)
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Contexts, Setup, SetupCache, Actions, Makefile, Justfile, PackageJson & Tools cover all parser/matcher branches", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        event: Schema.Literals(["push", "pull_request", "merge_group", "none"]),
        host: Schema.Literals(["linux", "darwin", "win32", "none"]),
        branch: Schema.Literals(["main", "develop", "feat/x", "release/1.0"]),
        uses: Schema.Literals([
          "actions/setup-node@v4",
          "actions/setup-python@v5",
          "actions/setup-go@v5",
          "actions/setup-java@v4",
          "oven-sh/setup-bun@v2",
          "mlugg/setup-zig@v2",
          "dtolnay/rust-toolchain@stable",
          "ruby/setup-ruby@v1",
          "pnpm/action-setup@v4",
          "actions/cache@v4",
          "unknown/action@v1"
        ]),
        cacheKind: Schema.Literals([
          "npm",
          "pnpm",
          "yarn",
          "pip",
          "pipenv",
          "poetry",
          "gradle",
          "maven",
          "bundler",
          "go",
          ""
        ]),
        makeVariant: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 5 }))),
        justVariant: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 5 })))
      })
    )

    const makefiles = [
      ".PHONY: all build test clean\nCC := gcc\nFLAGS ?= -O2\nFLAGS += -Wall\nall: build test\nbuild:\n\t@$(CC) $(FLAGS) -o app main.c\ntest: build\n\t./app --test\n",
      "ifdef DEBUG\nOPT = -g\nelse\nOPT = -O2\nendif\nifeq ($(OS),Windows_NT)\nEXT = .exe\nendif\n-include local.mk\n%.o: %.c\n\tcc -c $<\ncheck:\n\tmake test\n",
      "NAME = foo \\\n  bar\nexport FOO := 1\nbuild:\n\t+echo $(NAME) && \\\n\techo done\n",
      "a b: dep\n\t-rm -f tmp\ndep:\n\t@true\n",
      "SHELL := /bin/bash\n.ONESHELL:\nrun:\n\tset -e\n\techo hi\n",
      "x := $(shell date)\nrun:\n\techo $(x)\n"
    ]

    const justfiles = [
      "set shell := ['bash', '-cu']\nset dotenv-load\nexport RUST_LOG := 'debug'\nalias t := test\n[linux]\nbuild target='all':\n  echo building {{target}}\ntest: build\n  cargo test\n",
      "set allow-duplicate-recipes\n[macos]\ninstall:\n  brew install jq\n[linux]\ninstall:\n  apt-get install jq\n[windows]\ninstall:\n  choco install jq\n",
      "[no-cd]\n[private]\n_helper a b='x' *rest:\n  #!/usr/bin/env bash\n  set -euo pipefail\n  echo {{a}} {{b}} {{rest}}\ncheck: (_helper '1' '2')\n  echo ok\n",
      "ver := `node -v`\nfmt:\n  @dprint fmt\n  -echo {{ver}}\n",
      "import 'other.just'\nmod sub\nrun:\n  echo run\n",
      "default:\n  @just --list\n"
    ]

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ event, host, branch, uses, cacheKind, makeVariant, justVariant }) =>
          Effect.sync(() => {
            const ev: Contexts.Event | undefined = event === "none" ? undefined : event
            const h: Host | undefined = host === "none" ? undefined : host
            const facts: Contexts.Facts = { repository: "acme/widgets", defaultBranch: branch }
            const place: Contexts.Place = { job: "test", workflow: "CI" }

            Contexts.admits({ branches: ["main", "release/*"] }, branch)
            Contexts.admits({ "branches-ignore": ["feat/*"] }, branch)
            Contexts.admits(null, branch)
            Contexts.eventOf({
              push: { branches: ["main"] },
              pull_request: { branches: ["develop"] },
              merge_group: null
            }, branch)
            Contexts.eventName(ev, facts)
            const ghCtx = Contexts.github(ev, facts, place)
            const runCtx = Contexts.runner(h)
            Contexts.variables(ev, facts, place)
            Contexts.standIns(ev, facts, place)
            Contexts.eventFilesOf(facts)
            Contexts.eventFile(ev, facts)

            const scope: Expression.Scope = {
              context: (name) => name === "github" ? ghCtx : name === "runner" ? runCtx : undefined
            }
            for (
              const expr of [
                "github.repository",
                "github.repository_owner",
                "github.event_name",
                "github.ref",
                "github.ref_name",
                "github.sha",
                "github.workspace",
                "github.actor",
                "github.job",
                "github.workflow",
                "github.run_id",
                "github.base_ref",
                "github.head_ref",
                "github.server_url",
                "github.api_url",
                "github.graphql_url",
                "runner.os",
                "runner.arch",
                "runner.temp",
                "runner.tool_cache",
                "runner.name"
              ]
            ) {
              Expression.evaluate(expr, scope)
            }

            const inputs = {
              "node-version": "22",
              "python-version": "3.12",
              "go-version": "1.23",
              "java-version": "21",
              "bun-version": "1.3.0",
              version: "0.14.0",
              toolchain: "1.80.0",
              "ruby-version": "3.3",
              ...(cacheKind ? { cache: cacheKind } : {}),
              "bundler-cache": cacheKind === "bundler"
            }
            Setup.readSetup(uses, inputs)
            Setup.validToolName(cacheKind || "node")
            const sc = SetupCache.setupCache(uses, inputs)
            if (sc !== undefined) SetupCache.before(sc)

            Actions.checkoutProblems(
              {
                repository: "other/repo",
                ref: "v1",
                submodules: "recursive",
                lfs: true,
                path: "sub",
                token: "tok",
                "fetch-depth": 0,
                clean: false
              },
              "acme/widgets",
              (x) => x
            )
            Actions.checkoutProblems({}, "acme/widgets", (x) => x)
            Actions.readAction(
              "name: Composite\ninputs:\n  a:\n    default: '1'\nruns:\n  using: composite\n  steps:\n    - run: echo ${{ inputs.a }}\n      shell: bash\n"
            )
            Actions.readAction("name: JS\nruns:\n  using: node20\n  main: index.js\n")
            Actions.readAction(":::bad yaml[[[")

            Makefile.readMakefile("Makefile", makefiles[makeVariant]!, ["main.c", "local.mk", "pkg/a.c"])
            Justfile.readJustfile("Justfile", justfiles[justVariant]!, h ?? "linux")
            PackageJson.chooseRunner(JSON.stringify({ packageManager: "pnpm@10.0.0" }), ["pnpm-lock.yaml"])
            PackageJson.chooseRunner(undefined, ["bun.lock", "yarn.lock", "package-lock.json"])
            const patterns = PackageJson.readWorkspacePatterns(
              JSON.stringify({ workspaces: { packages: ["packages/*", "!packages/skip", "bad/{a,b}"] } }),
              undefined
            )
            const globs = PackageJson.readGlobs(patterns)
            PackageJson.readWorkspacePatterns(undefined, "packages:\n  - 'apps/*'\n  - '!apps/old'\n")
            PackageJson.readWorkspacePatterns(undefined, ":::bad")
            PackageJson.segmentMatcher("pkg-*").test("pkg-foo")

            const machine = Tools.thisMachine()
            Tools.machinePath(machine)
            Tools.machinePath({ host: "linux", path: "/usr/bin:/bin" })
            return globs.include.length >= 0
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Read.read & Machine.onThisMachine read real generated repositories across workflows, Makefile, Justfile, package.json & toolchains", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        includeWorkflow: Schema.Boolean,
        includeBrokenYaml: Schema.Boolean,
        includeMakefile: Schema.Boolean,
        includeJustfile: Schema.Boolean,
        includeWorkspaces: Schema.Boolean,
        includeTurbo: Schema.Boolean,
        includeToolchains: Schema.Boolean,
        includeComposite: Schema.Boolean,
        includeSmithersWorkspace: Schema.Boolean,
        pkgManager: Schema.Literals(["pnpm", "bun", "npm", "yarn"]),
        remoteStyle: Schema.Literals(["https", "ssh", "none"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (c) =>
          Effect.scoped(
            Effect.gen(function*() {
              const fs = yield* FileSystem.FileSystem
              const path = yield* Path.Path
              const spawner = yield* ChildProcessSpawner
              const root = yield* fs.makeTempDirectoryScoped()

              const write = (rel: string, content: string) =>
                Effect.gen(function*() {
                  const full = path.join(root, rel)
                  yield* fs.makeDirectory(path.dirname(full), { recursive: true })
                  yield* fs.writeFileString(full, content)
                })

              if (c.includeWorkflow) {
                yield* write(
                  ".github/workflows/ci.yml",
                  [
                    "name: CI",
                    "on: [push, pull_request]",
                    "jobs:",
                    "  build:",
                    "    runs-on: ubuntu-latest",
                    "    steps:",
                    "      - uses: actions/checkout@v4",
                    "      - uses: actions/setup-node@v4",
                    "        with: { node-version: '22', cache: pnpm }",
                    c.includeComposite ? "      - uses: ./.github/actions/prep\n        with: { flag: '1' }" : "",
                    "      - run: echo build && node -v"
                  ].filter(Boolean).join("\n")
                )
              }
              if (c.includeComposite) {
                yield* write(
                  ".github/actions/prep/action.yml",
                  "name: Prep\ninputs:\n  flag:\n    default: '0'\nruns:\n  using: composite\n  steps:\n    - run: echo prep ${{ inputs.flag }}\n      shell: bash\n"
                )
              }
              if (c.includeBrokenYaml) {
                yield* write(".github/workflows/broken.yaml", "jobs: [unclosed")
              }
              if (c.includeMakefile) {
                yield* write("Makefile", ".PHONY: test\ntest:\n\techo ok\n")
              }
              if (c.includeJustfile) {
                yield* write("Justfile", "check:\n  echo ok\n")
              }
              yield* write(
                "package.json",
                JSON.stringify({
                  name: "fuzz-root",
                  packageManager: `${c.pkgManager}@1.0.0`,
                  ...(c.includeWorkspaces ? { workspaces: ["packages/*", "!packages/skip", "bad/{a,b}"] } : {}),
                  scripts: { test: "node -e 0", build: "node -e 0" }
                })
              )
              if (c.includeWorkspaces) {
                yield* write("packages/a/package.json", JSON.stringify({ name: "a", scripts: { test: "node -e 0" } }))
                yield* write(
                  "packages/skip/package.json",
                  JSON.stringify({ name: "skip", scripts: { test: "node -e 0" } })
                )
                if (c.pkgManager === "pnpm") {
                  yield* write("pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n  - '!packages/skip'\n")
                  yield* write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
                }
              }
              if (c.includeTurbo) {
                yield* write("turbo.json", JSON.stringify({ tasks: { build: {}, test: { dependsOn: ["build"] } } }))
                if (c.includeWorkspaces) {
                  yield* write("packages/a/turbo.json", "{}")
                }
              }
              if (c.includeToolchains) {
                yield* write(".nvmrc", "22.0.0\n")
                yield* write(".python-version", "3.12\n")
                yield* write("go.mod", "module example.com/fuzz\n\ngo 1.23.0\n")
                yield* write("rust-toolchain.toml", "[toolchain]\nchannel = \"1.80.0\"\n")
              }
              if (c.includeSmithersWorkspace) {
                yield* write(".smithers/WORKSPACE.ts", "export default {}\n")
              }

              const git = (args: ReadonlyArray<string>) =>
                spawner.exitCode(ChildProcess.make("git", ["-C", root, ...args]))

              yield* git(["init", "--quiet"])
              yield* git(["add", "--all"])
              yield* git([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@example.test",
                "commit",
                "--quiet",
                "--allow-empty",
                "-m",
                "init"
              ])
              if (c.remoteStyle === "https") {
                yield* git(["remote", "add", "origin", "https://user:secret@github.com/acme/widgets.git"])
              } else if (c.remoteStyle === "ssh") {
                yield* git(["remote", "add", "origin", "git@github.com:acme/widgets.git"])
              }

              const inv = yield* Read.read(root)
              const onMachine = yield* Machine.onThisMachine(inv, { host: process.platform, patience: "2 seconds" })
              return inv.version === 1 && Array.isArray(inv.jobs) && onMachine.version === 1
            })
          ).pipe(Effect.provide(NodeServices.layer)),
        { seed, executions: fsExecutions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
