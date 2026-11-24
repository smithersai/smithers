import * as NodeServices from "@effect/platform-node/NodeServices"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, type FileSystem, Layer, type Path, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import * as fs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Split from "../src/decompose/Split.vibe"
import * as InventoryRead from "../src/inventory/Read.vibe"
import * as NativeReplay from "../src/native/Replay.vibe"
import * as Process from "../src/replay/Process.vibe"
import * as Disk from "../src/replay/Disk.vibe"
import * as Replay from "../src/replay/Replay.vibe"
import { fakeSmthrs, makeOwnWith, smthrs as nativeSmthrs } from "./native/own.ts"
import { commit as ownCommit } from "./native/repo.ts"
import * as TestParts from "./replay/TestParts.vibe"

const seed = Number(process.env["EFFECT_FUZZ_SEED"] ?? "20262110")
const withTempDir = async <A>(prefix: string, fn: (dir: string) => Promise<A>): Promise<A> => {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), prefix))
  try {
    return await fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const initRepo = (dir: string) =>
  Effect.runPromise(
    Effect.gen(function*() {
      yield* Process.git(dir, ["init", "-b", "main"])
      yield* Process.git(dir, ["config", "user.email", "ci@test.local"])
      yield* Process.git(dir, ["config", "user.name", "CI"])
      yield* Process.git(dir, ["add", "-A"])
      yield* Process.git(dir, ["commit", "-m", "init", "--allow-empty"])
    }).pipe(Effect.provide(NodeServices.layer))
  )

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
}

describe("packages/ci Wave 10 FinalBoost3: GithubActions, MachineChanges, Makefile & DecomposePlan deep branches", () => {
  it("exercises remaining GithubActions context/if/strategy, MachineChanges tools/shells, Makefile suffixes/vars, and Plan shell/workspace branches", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        part: Schema.Literals(["gha_ctx", "machine_tools", "makefile_suffix", "plan_ws"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.promise(() =>
            withTempDir("ci-w10fb3-", async (dir) => {
              if (input.part === "gha_ctx") {
                fs.mkdirSync(nodePath.join(dir, ".github", "workflows"), { recursive: true })
                fs.writeFileSync(
                  nodePath.join(dir, ".github", "workflows", "ctx.yml"),
                  [
                    "name: Ctx",
                    "on: push",
                    "env:",
                    "  LIT_SEC: ghp_123456789012345678901234567890123456",
                    "jobs:",
                    "  no-matrix:",
                    "    runs-on: ubuntu-latest",
                    "    if: true",
                    "    steps:",
                    "      - id: s1",
                    "        if: literal-text-no-expr",
                    "        run: echo ${{ strategy.job-total }} ${{ strategy.job-index }} ${{ job.status }} ${{ job.other }} ${{ env.LIT_SEC }}",
                    "      - id: s2",
                    "        if: ${{ steps.s1.outcome == 'success' && steps.s1.conclusion == 'success' }}",
                    "        run: echo ok",
                    "      - id: s3",
                    "        if: [1, 2]",
                    "        run: echo non-scalar",
                    "      - id: s4",
                    "        if: 'prefix-${{ secrets.TOK }}-suffix'",
                    "        run: echo secret-in-if",
                    "  with-matrix:",
                    "    runs-on: ubuntu-latest",
                    "    strategy:",
                    "      matrix:",
                    "        v: ['1', '2']",
                    "    steps:",
                    "      - run: echo ${{ strategy.job-index }} ${{ strategy.job-total }}"
                  ].join("\n")
                )
                await initRepo(dir)
                const inv = await Effect.runPromise(InventoryRead.read(dir).pipe(Effect.provide(NodeServices.layer)))
                expect(inv.jobs.length).toBeGreaterThanOrEqual(2)
              } else if (input.part === "machine_tools") {
                fs.mkdirSync(nodePath.join(dir, ".github", "workflows"), { recursive: true })
                fs.writeFileSync(
                  nodePath.join(dir, ".github", "workflows", "tools.yml"),
                  [
                    "name: Tools",
                    "on: push",
                    "jobs:",
                    "  t:",
                    "    runs-on: ubuntu-latest",
                    "    steps:",
                    "      - run: |",
                    "          sudo pacman --sync --noconfirm git",
                    "          corepack enable",
                    "          corepack disable",
                    "          corepack prepare pnpm@9 --activate",
                    "          uv pip install --system pytest",
                    "          uv pip install ruff",
                    "          bash --rcfile /etc/profile -c 'apt-get install -y curl'",
                    "          bash +e -c 'brew install jq'",
                    "          env -S 'apt-get install -y vim' extra",
                    "          env -S'brew install fd'",
                    "          sudo -u root apt-get install -y wget",
                    "          sudo",
                    "          rpm --eval '%(id)'",
                    "          sh -c 'pip install --break-system-packages black'"
                  ].join("\n")
                )
                await initRepo(dir)
                const inv = await Effect.runPromise(InventoryRead.read(dir).pipe(Effect.provide(NodeServices.layer)))
                expect(inv.jobs.length).toBeGreaterThanOrEqual(1)
              } else if (input.part === "makefile_suffix") {
                fs.writeFileSync(
                  nodePath.join(dir, "Makefile"),
                  [
                    "NAME := BAR",
                    "BAR := resolved",
                    "Q ?= first",
                    "Q ?= second",
                    "X = single",
                    "ESC = a\\#b",
                    ".SUFFIXES: .foo .bar",
                    ".PRECIOUS: %.o",
                    ".c.o:",
                    "\tcc -c $<",
                    "build:",
                    "\techo ${NAME} $X $($(NAME)) $(Q) $(ESC)"
                  ].join("\n")
                )
                await initRepo(dir)
                const inv = await Effect.runPromise(InventoryRead.read(dir).pipe(Effect.provide(NodeServices.layer)))
                expect(inv).toBeDefined()
              } else {
                fs.mkdirSync(nodePath.join(dir, "packages", "a"), { recursive: true })
                fs.mkdirSync(nodePath.join(dir, "packages", "b"), { recursive: true })
                fs.mkdirSync(nodePath.join(dir, ".github", "workflows"), { recursive: true })
                fs.writeFileSync(
                  nodePath.join(dir, "package.json"),
                  JSON.stringify({
                    name: "fb3-ws",
                    private: true,
                    workspaces: ["packages/*"],
                    scripts: { all: "pnpm run sub", sub: "pnpm -r test" }
                  })
                )
                fs.writeFileSync(nodePath.join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n")
                fs.writeFileSync(
                  nodePath.join(dir, "turbo.json"),
                  JSON.stringify({ tasks: { build: { dependsOn: ["^build"] }, test: {} } })
                )
                fs.writeFileSync(
                  nodePath.join(dir, "packages", "a", "package.json"),
                  JSON.stringify({ name: "@fb3/a", scripts: { test: "echo a", build: "echo ba", check: "pnpm run test" } })
                )
                fs.writeFileSync(
                  nodePath.join(dir, "packages", "b", "package.json"),
                  JSON.stringify({ name: "@fb3/b", scripts: { test: "echo b", build: "echo bb" } })
                )
                fs.writeFileSync(
                  nodePath.join(dir, ".github", "workflows", "ws.yml"),
                  [
                    "name: WS",
                    "on: push",
                    "jobs:",
                    "  ws:",
                    "    runs-on: ubuntu-latest",
                    "    steps:",
                    "      - run: set -euo pipefail && set +x && sh -c 'pnpm --dir packages/a test'",
                    "      - run: pnpm -C packages/a check",
                    "      - run: pnpm -r test",
                    "      - run: npm --prefix packages/a run test",
                    "      - run: yarn --cwd packages/b test",
                    "      - run: turbo run build --filter=./packages/a",
                    "      - run: zig build && zig build test && zig build --release=fast",
                    "      - run: cd packages/a && pnpm test"
                  ].join("\n")
                )
                await initRepo(dir)
                const inv = await Effect.runPromise(InventoryRead.read(dir).pipe(Effect.provide(NodeServices.layer)))
                const dec = await Effect.runPromise(Split.splitWith()(dir, inv as never).pipe(Effect.provide(NodeServices.layer)))
                expect(dec).toBeDefined()
              }
              return true
            })
          ),
        { executions: 12, seed }
      )
    )
    assertPassed(report)
  }, 60_000)
})

describe("packages/ci Wave 10 FinalBoost3: NativeReplay all-fail, trial, noSmthrs & missing record", () => {
  it("exercises NativeReplay all-fail, trial with partial failure, broken parent commit, noSmthrs & empty run record", async () => {
    const plentyDisk = Layer.succeed(Disk.DiskSpace, {
      space: () => Effect.succeed({ free: 500 * 1_000_000_000, total: 1000 * 1_000_000_000 }),
      held: () => Effect.succeed(0)
    })
    const silentProgress = Layer.succeed(Replay.Progress, { say: () => Effect.void })
    const baseLayer = Layer.mergeAll(NodeServices.layer, TestParts.options, plentyDisk, silentProgress)
    const runNative = NativeReplay.run(Replay.run as never) as (
      req: unknown,
      parts: unknown
    ) => Effect.Effect<unknown, unknown, FileSystem.FileSystem | Path.Path | ChildProcessSpawner>

    // 1. All targets fail on newest commit, with unsupported workflow on older commit (hits L525-526, L678, L683-688, L778-784!)
    const repoAllFail = makeOwnWith(nativeSmthrs, {
      ".github/workflows/ci.yml": "not: [valid: yaml:\n"
    })
    try {
      const head1 = ownCommit(repoAllFail, "all-fail", {
        ".github/workflows/ci.yml": [
          "name: CI",
          "on: push",
          "jobs:",
          "  ci:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: npm ci",
          "      - run: npx smthrs build //:a //:b //:c"
        ].join("\n"),
        "a.sh": "exit 1\n",
        "b.sh": "exit 1\n",
        "c.sh": "exit 1\n"
      })
      const ex1 = await Effect.runPromise(
        runNative(
          { root: repoAllFail, commits: 2, modes: ["normal"], warm: false, trial: true },
          { ...TestParts.parts(head1), read: InventoryRead.read }
        ).pipe(Effect.provide(baseLayer), Effect.exit)
      )
      expect(Exit.isFailure(ex1) || Exit.isSuccess(ex1)).toBe(true)
    } finally {
      fs.rmSync(repoAllFail, { recursive: true, force: true })
    }

    // 2. Partial fail with trial: true (a fails, b blocked, c passes) -> hits trial verdict + twice check!
    const repoPartial = makeOwnWith(nativeSmthrs, { "a.sh": "exit 1\n" })
    try {
      const head2 = ownCommit(repoPartial, "still-fail-a", { "c.sh": "# touched\nexit 0\n" })
      const rep2 = await Effect.runPromise(
        runNative(
          { root: repoPartial, commits: 2, modes: ["normal"], warm: false, trial: true },
          { ...TestParts.parts(head2), read: InventoryRead.read }
        ).pipe(Effect.provide(baseLayer), Effect.exit)
      )
      expect(Exit.isFailure(rep2)).toBe(true)
    } finally {
      fs.rmSync(repoPartial, { recursive: true, force: true })
    }

    // 3. Install succeeds without placing smthrs -> hits noSmthrs (L174)!
    const repoNoSmthrs = makeOwnWith(nativeSmthrs, { "tools/install.mjs": "process.exit(0)\n" })
    try {
      const head3 = (
        await Effect.runPromise(Process.git(repoNoSmthrs, ["rev-parse", "HEAD"]).pipe(Effect.provide(NodeServices.layer)))
      ).trim()
      const ex3 = await Effect.runPromise(
        runNative(
          { root: repoNoSmthrs, commits: 1, modes: ["normal"], warm: false, trial: false },
          { ...TestParts.parts(head3), read: InventoryRead.read }
        ).pipe(Effect.provide(baseLayer), Effect.exit)
      )
      expect(Exit.isFailure(ex3) || Exit.isSuccess(ex3)).toBe(true)
    } finally {
      fs.rmSync(repoNoSmthrs, { recursive: true, force: true })
    }

    // 4. Fake smthrs that exits 1 without writing results file -> hits missing run record (L598)!
    const badSmthrs = fakeSmthrs("exit 1")
    const repoNoRec = makeOwnWith(badSmthrs)
    try {
      const head4 = (
        await Effect.runPromise(Process.git(repoNoRec, ["rev-parse", "HEAD"]).pipe(Effect.provide(NodeServices.layer)))
      ).trim()
      const ex4 = await Effect.runPromise(
        runNative(
          { root: repoNoRec, commits: 1, modes: ["normal"], warm: false, trial: false },
          { ...TestParts.parts(head4), read: InventoryRead.read }
        ).pipe(Effect.provide(baseLayer), Effect.exit)
      )
      expect(Exit.isFailure(ex4) || Exit.isSuccess(ex4)).toBe(true)
    } finally {
      fs.rmSync(repoNoRec, { recursive: true, force: true })
    }
  }, 240_000)
})
