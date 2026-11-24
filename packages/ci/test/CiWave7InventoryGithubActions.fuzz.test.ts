import { describe, expect, it } from "@effect/vitest"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import type { Facts } from "../src/inventory/Contexts.vibe"
import * as Expression from "../src/inventory/Expression.ts"
import * as GithubActions from "../src/inventory/GithubActions.vibe"
import * as Setup from "../src/inventory/Setup.vibe"

const seed = 7071
const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? 50)

const SeedSchema = Schema.Struct({
  salt: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 99 })),
  tag: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]{1,8}$/))
})

const workflowScenarios = (
  tag: string
): ReadonlyArray<{ readonly file: string; readonly yaml: string; readonly facts: Facts }> => {
  const localFiles: Record<string, string> = {
    ".github/workflows/called.yml": [
      "on:",
      "  workflow_call:",
      "    inputs:",
      "      msg:",
      "        type: string",
      "        required: true",
      "      count:",
      "        type: number",
      "        default: 3",
      "      flag:",
      "        type: boolean",
      "      badtype:",
      "        type: object",
      "permissions:",
      "  contents: write",
      "  issues: write",
      "env:",
      "  CALLED_ENV: ok",
      "jobs:",
      "  inner:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo ${{ inputs.msg }} ${{ inputs.count }} ${{ inputs.flag }} ${{ env.CALLED_ENV }}"
    ].join("\n"),
    ".github/workflows/cycle.yml": [
      "on: workflow_call",
      "jobs:",
      "  again:",
      "    uses: ./.github/workflows/cycle.yml"
    ].join("\n"),
    ".github/workflows/not-callable.yml": [
      "on: push",
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: echo hi"
    ].join("\n"),
    ".github/actions/comp/action.yml": [
      "name: Composite",
      "inputs:",
      "  val:",
      "    default: hi",
      "  dyn:",
      "    default: ''",
      "outputs:",
      "  res:",
      "    value: ${{ steps.out.outputs.v }}-${{ inputs.val }}",
      "runs:",
      "  using: composite",
      "  steps:",
      "    - id: out",
      "      shell: bash",
      "      run: echo v=${{ inputs.val }}-${{ inputs.dyn }}-${{ github.action_path }}"
    ].join("\n")
  }
  const baseFacts: Facts = {
    repository: `acme/${tag}`,
    defaultBranch: "main",
    read: (p) => localFiles[p]
  }
  return [
    {
      file: ".github/workflows/ci.yml",
      facts: baseFacts,
      yaml: [
        "name: CI",
        "on:",
        "  pull_request:",
        "    branches: ['release/[0-9]+', 'main']",
        "permissions: write-all",
        "env:",
        "  API_KEY: literal-secret-value-1234567890",
        "  BASE_VAR: hello",
        "  SEC_ENV: ${{ secrets.MY_SEC }}",
        "  BAD_ENV:",
        "    - a",
        "jobs:",
        "  main:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "      - uses: actions/setup-python@v5",
        "        with:",
        "          python-version: '3.12'",
        "      - id: first",
        "        shell: sh",
        "        run: |",
        "          echo ${{ github.event.pull_request.head.sha }}",
        "          echo ${{ github.event.pull_request.base.sha }}",
        "          echo ${{ github.event.pull_request.base.ref }}",
        "          echo ${{ github.event.pull_request.base.repo.fork }}",
        "          echo ${{ github.event.pull_request.base.repo.full_name }}",
        "          echo ${{ github.event.pull_request.labels }}",
        "          echo ${{ github.event.pull_request.draft }}",
        "          echo ${{ github.ref_type }} ${{ github.triggering_actor }}",
        "          echo ${{ github.run_number }} ${{ github.run_attempt }}",
        "          echo ${{ runner.environment }} ${{ runner.debug }}",
        "          echo ${{ job.status }} ${{ strategy.job-total }}",
        "          echo ${{ hashFiles('src/*.ts', '!src/skip.ts') }}",
        "      - id: dyn",
        "        if: ${{ !failure() && steps.first.outcome == 'success' && (env.BASE_VAR != 'no' || contains(env.AFTER_RUN, 'x')) && startsWith(format('{0}-{1}', env.BASE_VAR, steps.first.outcome), 'h') && endsWith(env.BASE_VAR, 'o') }}",
        "        shell: 'bash --noprofile --norc -eo pipefail {0}'",
        "        working-directory: ./sub/",
        "        env:",
        "          OWN_VAR: ${{ format('a{0}b', env.BASE_VAR) }}",
        "          'BAD-NAME': ${{ env.AFTER_RUN }}",
        "        run: echo ${{ env.OWN_VAR }} ${{ env.AFTER_RUN }} ${{ env.BASE_VAR }}",
        "      - id: skipped",
        "        if: false",
        "        run: echo never",
        "      - id: uses-skipped",
        "        run: echo ${{ steps.skipped.outcome }} ${{ steps.skipped.outputs.x }}",
        "      - id: comp",
        "        uses: ./.github/actions/comp",
        "        with:",
        "          val: plain",
        "          dyn: ${{ env.AFTER_RUN }}",
        "      - run: echo ${{ steps.comp.outputs.res }}"
      ].join("\n")
    },
    {
      file: ".github/workflows/mg.yml",
      facts: { repository: `acme/${tag}` },
      yaml: [
        "on: merge_group",
        "jobs:",
        "  mg:",
        "    runs-on: ubuntu-latest",
        "    env: ${{ toJSON(github) }}",
        "    steps:",
        "      - run: echo ${{ github.event.merge_group.head_sha }} ${{ github.event.merge_group.base_sha }} ${{ github.event.merge_group.base_ref }} ${{ github.event.merge_group.extra }}",
        "      - run: echo ${{ github.unknown_field }} ${{ runner.unknown_field }} ${{ job.unknown_field }}",
        "      - run: echo ${{ github.token }}",
        "      - if: ${{ secrets.TOP_SECRET == 'x' }}",
        "        run: echo sec",
        "      - if: ${{ github.unknown_field }}",
        "        run: echo cond-unknown",
        "      - if: 123",
        "        run: echo num-if",
        "      - working-directory: ../outside",
        "        run: echo out",
        "      - working-directory: ${{ secrets.DIR_SEC }}",
        "        run: echo secdir",
        "      - working-directory:",
        "          nested: true",
        "        run: echo baddir",
        "      - shell:",
        "          bad: true",
        "        run: echo badshell",
        "      - timeout-minutes: ${{ github.unknown_field }}",
        "        run: echo badtimeout",
        "      - id: 'bad id!'",
        "        run: echo badid",
        "      - name: empty step"
      ].join("\n")
    },
    {
      file: ".github/workflows/matrix.yml",
      facts: baseFacts,
      yaml: [
        "on: push",
        "jobs:",
        "  nested:",
        "    runs-on: ${{ matrix.cfg.os }}",
        "    strategy:",
        "      matrix:",
        "        include:",
        "          - cfg:",
        "              os: ubuntu-latest",
        "              flag: true",
        "              num: 1",
        "              q: \"it's\"",
        "          - cfg:",
        "              os: ubuntu-24.04",
        "              flag: false",
        "              num: 2",
        "              q: ok",
        "    steps:",
        "      - if: ${{ matrix.cfg.flag == true && matrix.cfg.num == 1 }}",
        "        working-directory: ./${{ matrix.cfg.os }}",
        "        run: echo ${{ matrix.cfg.q }}",
        "  bad-matrix-key:",
        "    runs-on: ubuntu-latest",
        "    strategy:",
        "      matrix:",
        "        'bad key!': [a]",
        "    steps:",
        "      - run: echo ${{ matrix.x }}",
        "  collide-matrix:",
        "    runs-on: ubuntu-latest",
        "    strategy:",
        "      matrix:",
        "        v: ['1', 1]",
        "    steps:",
        "      - run: echo ${{ matrix.v }}",
        "  dynamic-matrix:",
        "    runs-on: ubuntu-latest",
        "    strategy: ${{ fromJSON('{\"matrix\":{}}') }}",
        "    steps:",
        "      - run: echo hi",
        "  unknown-runner:",
        "    runs-on: ${{ github.unknown_runner }}",
        "    steps:",
        "      - run: echo hi"
      ].join("\n")
    },
    {
      file: ".github/workflows/callers.yml",
      facts: baseFacts,
      yaml: [
        "on: pull_request",
        "permissions:",
        "  contents: write",
        "jobs:",
        "  ok-call:",
        "    uses: ./.github/workflows/called.yml",
        "    with:",
        "      msg: hello-${{ github.repository }}",
        "      count: 5",
        "      flag: true",
        "  bad-call:",
        "    if: ${{ github.unknown_cond }}",
        "    uses: ./.github/workflows/called.yml",
        "    with:",
        "      extra: 1",
        "      count: 'not-a-number'",
        "      flag: ${{ github.run_number }}",
        "      msg: ${{ secrets.CALL_SEC }}",
        "  nonmap-call:",
        "    uses: ./.github/workflows/called.yml",
        "    with: 'not-a-map'",
        "  cycle-call:",
        "    uses: ./.github/workflows/cycle.yml",
        "  noncallable:",
        "    uses: ./.github/workflows/not-callable.yml",
        "  not-a-map: 42",
        "  bad-needs:",
        "    needs: 123",
        "    runs-on: ubuntu-latest",
        "    timeout-minutes: ${{ github.unknown_t }}",
        "    steps:",
        "      - run: echo hi",
        "  no-steps:",
        "    runs-on: ubuntu-latest"
      ].join("\n")
    },
    {
      file: ".github/workflows/actions.yml",
      facts: baseFacts,
      yaml: [
        "# generated by smthrs ci",
        "on: schedule",
        "jobs:",
        "  tools:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/cache@v4",
        "        id: c-bad",
        "      - uses: actions/cache@v4",
        "        id: c-fail",
        "        with:",
        "          path: ~/.cache",
        "          key: k-${{ hashFiles('package.json') }}",
        "          fail-on-cache-miss: true",
        "      - uses: actions/cache@v4",
        "        id: c-ok",
        "        with:",
        "          path: ~/.cache",
        "          key: k-${{ hashFiles('*.json') }}",
        "      - run: echo ${{ steps.c-ok.outputs.cache-hit }} ${{ github.event.repository.full_name }}",
        "      - uses: taiki-e/install-action@cargo-nextest",
        "        with:",
        "          tool: 'ripgrep@14,fd,'",
        "      - uses: taiki-e/install-action@v2",
        "        with:",
        "          tool: 'bad tool!'",
        "      - uses: dtolnay/rust-toolchain@nightly",
        "      - uses: gradle/actions/setup-gradle@v4",
        "        with:",
        "          gradle-version: '8.7'",
        "      - uses: prefix-dev/setup-pixi@v0.8",
        "        with:",
        "          activate-environment: true",
        "          run_install: true",
        "      - uses: actions/setup-node@v4",
        "        with:",
        "          node-version-file: .nvmrc",
        "      - uses: someorg/setup-custom@v1",
        "        with:",
        "          token: ${{ secrets.SETUP_SEC }}",
        "      - uses: actions/upload-artifact@v4",
        "        with:",
        "          name: [1, 2]",
        "      - uses: actions/upload-artifact@v4",
        "        with:",
        "          name: literal-secret-token-1234567890",
        "      - uses: actions/upload-artifact@v4",
        "        with:",
        "          name: ${{ secrets.ART_SEC }}",
        "      - uses: actions/upload-artifact@v4",
        "        with:",
        "          name: ${{ github.unknown_x }}",
        "      - id: pkg",
        "        run: sudo apt-get install -y jq",
        "      - run: echo ${{ steps.pkg.outputs.x }}",
        "      - if: ${{ env.DYN < 5 }}",
        "        run: echo cmp-refused",
        "      - if: ${{ format('{5}', env.DYN) }}",
        "        run: echo fmt-refused",
        "      - if: ${{ toJSON(env.DYN) }}",
        "        run: echo fn-refused",
        "      - if: ${{ contains(fromJSON('[1,2]'), env.DYN) }}",
        "        run: echo list-refused",
        "      - run: echo ${{ env.API_KEY }} ${{ env.PYTHON_ENV }}"
      ].join("\n")
    },
    {
      file: ".github/workflows/pr-extra.yml",
      facts: baseFacts,
      yaml: [
        "on: pull_request",
        "jobs:",
        "  pr:",
        "    runs-on: ubuntu-latest",
        "    strategy:",
        "      matrix:",
        "        num: [1, 2]",
        "        flag: [true, false]",
        "    steps:",
        "      - id: s1",
        "        run: echo ${{ github.event.pull_request.head.unknown }} ${{ github.event.pull_request.unknown }}",
        "      - if: ${{ matrix.num == env.DYN }}",
        "        run: echo typed-cmp",
        "      - if: ${{ (steps.s1.outcome == null) && !false }}",
        "        run: echo null-cmp",
        "      - if: ${{ format('{0}', steps.s1.outcome) == 'success' }}",
        "        run: echo fmt-cmp"
      ].join("\n")
    },
    {
      file: ".github/workflows/bad.yml",
      facts: baseFacts,
      yaml: "on: push\nname: no-jobs\n"
    }
  ]
}

describe("packages/ci Wave-7 GithubActions, Runner, Expression, Contexts, Setup fuzz", () => {
  it.effect("fuzzes GithubActions.readWorkflow across reusable calls, composites, matrix, setup, cache, and Runner compilation", () =>
    Effect.gen(function*() {
      const report = yield* Fuzz.run(
        Arbitrary.schema(SeedSchema),
        ({ salt, tag }) =>
          Effect.sync(() => {
            const scenarios = workflowScenarios(tag)
            for (let i = 0; i < scenarios.length; i++) {
              const sc = scenarios[(salt + i) % scenarios.length]!
              const parsed = GithubActions.readWorkflow(sc.file, sc.yaml, sc.facts)
              expect(Array.isArray(parsed.jobs)).toBe(true)
              expect(Array.isArray(parsed.unsupported)).toBe(true)
              expect(Array.isArray(parsed.toolchains)).toBe(true)
            }
            return true
          }),
        { seed, executions }
      )
      expect(report._tag).toBe("Passed")
    }))

  it.effect("fuzzes Expression evaluate/fill/finish/toNumber/toText/variablesOf edge cases", () =>
    Effect.gen(function*() {
      const report = yield* Fuzz.run(
        Arbitrary.schema(SeedSchema),
        ({ salt, tag }) =>
          Effect.sync(() => {
            const dynVar = Expression.variable(`env:${JSON.stringify({ name: "X", held: null })}`, "env.X")
            const scopeMap = new Map<string, Expression.Context>([
              ["arr", Expression.value([{ a: 1, b: tag }, { a: 2, b: null }, { c: 3 }])],
              ["obj", Expression.value({ k1: { v: 10 }, k2: { v: 20 } })],
              ["dyn", dynVar],
              ["num", Expression.value(salt + 1)]
            ])
            const scope: Expression.Scope = { context: (name) => scopeMap.get(name) }

            const exprs = [
              "arr.*.a",
              "arr.*.b",
              "obj.*.v",
              "num.*",
              "dyn.*",
              "arr[0].a",
              "arr[99]",
              "arr['bad']",
              "contains('hello world', 'world')",
              "contains(arr.*.a, 1)",
              "format('{bad}', 1)",
              "format('{0}-{1}', dyn, num)",
              "unknownFn(1)",
              "contains('a')",
              "!dyn",
              "startsWith(dyn, 'a')",
              "endsWith(dyn, 'b')",
              "(".repeat(140) + "true" + ")".repeat(140)
            ]
            for (let i = 0; i < exprs.length; i++) {
              const e = exprs[(salt + i) % exprs.length]!
              const res = Expression.evaluate(e, scope)
              if (res.kind === "ok") {
                const vars = Expression.variablesOf(res.residual)
                expect(Array.isArray(vars)).toBe(true)
                const fin = Expression.finish(res.residual, () => "hello")
                expect(fin).toBeDefined()
              }
            }

            expect(Number.isNaN(Expression.toNumber({ a: 1 }))).toBe(true)
            expect(Expression.toText(1e20)).toContain("E+")
            expect(Expression.toText(1e-7)).toContain("E-")
            expect(Expression.toText(1.234567890123456)).toBeTruthy()
            expect(Expression.formatPieces("{0} {bad}")).toBeUndefined()
            return true
          }),
        { seed, executions }
      )
      expect(report._tag).toBe("Passed")
    }))

  it.effect("fuzzes Setup.readSetup edge cases (local, docker, rustflags, gradle, pixi, taiki-e, version-file)", () =>
    Effect.gen(function*() {
      const report = yield* Fuzz.run(
        Arbitrary.schema(SeedSchema),
        ({ tag }) =>
          Effect.sync(() => {
            expect(Setup.readSetup("./local", {})).toBeUndefined()
            expect(Setup.readSetup("docker://alpine:3", {})).toBeUndefined()
            expect(Setup.readSetup("no-slash", {})).toBeUndefined()
            const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
              ["taiki-e/install-action@cargo-nextest", {}],
              ["taiki-e/install-action@v2", { tool: "ripgrep@14, fd, , @bad" }],
              ["taiki-e/install-action@v2", { tool: "bad name!" }],
              ["dtolnay/rust-toolchain@nightly", {}],
              ["dtolnay/rust-toolchain@master", { toolchain: "stable" }],
              ["gradle/actions/setup-gradle@v4", { "gradle-version": "8.7" }],
              ["gradle/actions/setup-gradle@v4", {}],
              ["prefix-dev/setup-pixi@v0.8", { "activate-environment": true }],
              ["prefix-dev/setup-pixi@v0.8", { run_install: "true" }],
              ["actions-rs/toolchain@v1", { target: "wasm32-unknown-unknown" }],
              ["Swatinem/rust-cache@v2", {}],
              [`${tag}/setup-custom@v1`, {}],
              ["actions/setup-node@v4", { "node-version-file": ".nvmrc" }],
              ["actions/setup-go@v5", { "go-version-file": "go.mod" }],
              ["actions/setup-python@v5", { "python-version": "3.12", "python-version-file": ".python-version" }]
            ]
            for (const [uses, withInputs] of cases) {
              Setup.readSetup(uses, withInputs)
            }
            return true
          }),
        { seed, executions }
      )
      expect(report._tag).toBe("Passed")
    }))
})
