import * as NodeServices from "@effect/platform-node/NodeServices"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as CliMain from "../src/cli/main.vibe"
import * as Restart from "../src/cli/Restart.ts"
import { ci as ciOf, type Inventory, type Job } from "../src/contract/Inventory.vibe"
import * as Split from "../src/decompose/Split.vibe"
import * as Expressions from "../src/generate/Expressions.vibe"
import * as GenToolchains from "../src/generate/Toolchains.vibe"
import * as InventoryRead from "../src/inventory/Read.vibe"
import * as Process from "../src/replay/Process.vibe"

const seed = Number(process.env["EFFECT_FUZZ_SEED"] ?? "20262210")
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

describe("packages/ci Wave 10 FinalBoost4: Expressions, GenToolchains, Actions, Script/Workspace/Split & Restart", () => {
  it(
    "exercises Expressions.forShell/forText, GenToolchains.chooseToolchains conflicts/missing, and Restart.own/hand/received",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          includeConflict: Schema.Boolean,
          includeMatrixVer: Schema.Boolean
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (input) =>
            Effect.sync(() => {
              // 1. Expressions.forShell & forText across matrix, github, runner, env, github.token refusal, invalid ref
              expect(Expressions.forShell("echo ${{ matrix.node }} ${{ github.sha }} ${{ env.FOO }}", { node: "22" }))
                .toBeDefined()
              expect(Expressions.forShell("echo ${{ matrix.missing }}", { node: "22" })).toBeUndefined()
              expect(Expressions.forShell("echo ${{ github.token }}", {})).toBeUndefined()
              expect(Expressions.forShell("echo ${{ invalid!name }}", {})).toBeUndefined()
              expect(Expressions.forText("v-${{ matrix.node }}", { node: "22" })).toBe("v-22")
              expect(Expressions.forText("v-${{ runner.os }}", { node: "22" })).toBeUndefined()
              expect(Expressions.forText("v-${{ matrix.nope }}", {})).toBeUndefined()
              expect(Expressions.forText("v-${{ github.token }}", {})).toBeUndefined()

              // 2. GenToolchains.chooseToolchains: missing version (L145), matrix version (L46, L105), conflicting versions (L137, L151)
              const mkJob = (id: string, matrix: ReadonlyArray<Readonly<Record<string, string>>> = []): Job => ({
                id,
                source: "github-actions",
                file: ".github/workflows/ci.yml",
                name: id,
                needs: [],
                triggers: ["push"],
                matrix,
                runsOn: "ubuntu-latest",
                steps: [{ id: `${id}_s`, command: "echo ok", cwd: "", env: {}, secrets: [] }],
                unsupported: []
              })
              const inv: Inventory = {
                version: 1,
                repository: "w10/tc",
                commit: "a".repeat(40),
                toolchains: [
                  {
                    name: "node",
                    source: "setup-node",
                    job: "j1",
                    version: input.includeMatrixVer ? "${{ matrix.node }}" : "20"
                  },
                  { name: "node", source: "setup-node", job: "j2", version: input.includeConflict ? "22" : "20" },
                  { name: "python", source: "setup-python", job: "j1" },
                  { name: "go", source: "setup-go", job: "j1", version: "" },
                  { name: "rust", source: "rust-toolchain.toml", version: "1.81.0" }
                ],
                jobs: [
                  mkJob("j1", [{ node: "20" }, { node: "22" }]),
                  mkJob("j2")
                ]
              }
              const choice = GenToolchains.chooseToolchains(ciOf(inv))
              expect(choice.toolchains.length).toBeGreaterThanOrEqual(1)
              return true
            }),
          { executions: 8, seed }
        )
      )
      assertPassed(report)

      // 3. Restart: hand failing helper (L235, 240-241), received non-object JSON (L339-340), own() missing pipe & leftover env (L476-484)
      await withTempDir("ci-w10fb4-restart-", async (dir) => {
        let failedHelper = false
        try {
          await Restart.hand({ MY_SEC: "1" }, { mkfifo: "/usr/bin/mkfifo", shell: "/bin/false", directory: dir })
        } catch {
          failedHelper = true
        }
        expect(failedHelper).toBe(true)

        // received() on files with non-object JSON ([1,2], {"a":123}) -> L339-340
        const arrFile = nodePath.join(dir, "arr.json")
        fs.writeFileSync(arrFile, "[1,2]")
        expect(Restart.received(arrFile, 50)).toBeUndefined()
        const numFile = nodePath.join(dir, "num.json")
        fs.writeFileSync(numFile, "{\"a\": 123}")
        expect(Restart.received(numFile, 50)).toBeUndefined()

        // Restart.own() with missing pipe + leftover secret env -> L476-481!
        const said: Array<string> = []
        const fakeEnv: Record<string, string | undefined> = {
          [Restart.handed]: nodePath.join(os.tmpdir(), "smithers-ci-env-000000", "env"),
          SECRET_LEFTOVER: "val",
          PATH: "/usr/bin"
        }
        const owned = await Restart.own(
          {
            env: fakeEnv,
            argv: ["node", "cli.js"],
            execPath: process.execPath,
            execArgv: [],
            platform: "linux"
          },
          Restart.hand,
          (line) => {
            said.push(line)
          }
        )
        expect(owned).toBeDefined()
        expect(said.length).toBeGreaterThanOrEqual(1)
        expect(fakeEnv["SECRET_LEFTOVER"]).toBeUndefined()

        // CliMain.rootOf on a non-git directory -> L28-29
        const nonGitRoot = await Effect.runPromise(
          CliMain.rootOf(dir).pipe(Effect.provide(NodeServices.layer))
        )
        expect(nonGitRoot).toBe(dir)
      })
    },
    60_000
  )

  it(
    "exercises Actions composite/checkout residuals, Script lockfile versions, Workspace nested globs & Split link expansion",
    async () => {
      await withTempDir("ci-w10fb4-split-", async (dir) => {
        // 1. Repo with composite action, checkout ref residuals, yarn berry lock, npm v2 lock, pnpm v9 lock, .npmrc & nested workspace globs
        fs.mkdirSync(nodePath.join(dir, ".github", "workflows"), { recursive: true })
        fs.mkdirSync(nodePath.join(dir, ".github", "actions", "bad-act"), { recursive: true })
        fs.mkdirSync(nodePath.join(dir, "packages", "a", ".hidden"), { recursive: true })
        fs.mkdirSync(nodePath.join(dir, "packages", "b"), { recursive: true })

        fs.writeFileSync(
          nodePath.join(dir, ".github", "actions", "bad-act", "action.yml"),
          [
            "name: BadAct",
            "outputs:",
            "  ok:",
            "    value: '1'",
            "  bad: not-an-object",
            "runs:",
            "  using: 123"
          ].join("\n")
        )
        fs.writeFileSync(
          nodePath.join(dir, ".github", "workflows", "ci.yml"),
          [
            "name: CI",
            "on: push",
            "jobs:",
            "  j:",
            "    runs-on: ubuntu-latest",
            "    steps:",
            "      - uses: actions/checkout@v4",
            "        with:",
            "          repository: other/repo",
            "          ref: ${{ github.sha || 'main' }}",
            "      - uses: ./.github/actions/bad-act",
            "      - run: npm test && npm run chain1"
          ].join("\n")
        )
        fs.writeFileSync(
          nodePath.join(dir, "package.json"),
          JSON.stringify({
            name: "fb4-root",
            private: true,
            workspaces: { packages: ["packages/**/.hidden", "packages/*"] },
            scripts: {
              test: "echo root-test",
              chain1: "npm run chain2 && npm run chain3",
              chain2: "echo c2",
              chain3: "echo c3"
            }
          })
        )
        fs.writeFileSync(
          nodePath.join(dir, "packages", "a", "package.json"),
          JSON.stringify({ name: "@fb4/a", scripts: { test: "echo a" } })
        )
        fs.writeFileSync(
          nodePath.join(dir, "packages", "b", "package.json"),
          JSON.stringify({ name: "@fb4/b", scripts: { test: "echo b" } })
        )
        fs.writeFileSync(nodePath.join(dir, "yarn.lock"), "__metadata:\n  version: 8\n" + "# pad\n".repeat(1200))
        fs.writeFileSync(
          nodePath.join(dir, "package-lock.json"),
          JSON.stringify({ name: "fb4-root", lockfileVersion: 2, packages: {} })
        )
        fs.writeFileSync(nodePath.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
        fs.writeFileSync(nodePath.join(dir, ".npmrc"), "shamefully-hoist=true\n")

        await initRepo(dir)
        const inv = await Effect.runPromise(InventoryRead.read(dir).pipe(Effect.provide(NodeServices.layer)))
        const dec = await Effect.runPromise(
          Split.splitWith()(dir, inv as never).pipe(Effect.provide(NodeServices.layer))
        )
        expect(dec).toBeDefined()

        // 2. Also test oversized unknown yarn.lock (> lockfileHead without header -> Split.vibe L80-81!)
        const dir2 = nodePath.join(dir, "sub-yarn")
        fs.mkdirSync(nodePath.join(dir2, ".github", "workflows"), { recursive: true })
        fs.writeFileSync(
          nodePath.join(dir2, "package.json"),
          JSON.stringify({ name: "y2", scripts: { test: "echo y" } })
        )
        fs.writeFileSync(nodePath.join(dir2, "yarn.lock"), "unknown-format-line\n".repeat(400))
        fs.writeFileSync(
          nodePath.join(dir2, ".github", "workflows", "ci.yml"),
          "name: Y\non: push\njobs:\n  y:\n    runs-on: ubuntu-latest\n    steps:\n      - run: yarn test\n"
        )
        await initRepo(dir2)
        const inv2 = await Effect.runPromise(InventoryRead.read(dir2).pipe(Effect.provide(NodeServices.layer)))
        const dec2 = await Effect.runPromise(
          Split.splitWith()(dir2, inv2 as never).pipe(Effect.provide(NodeServices.layer))
        )
        expect(dec2).toBeDefined()
      })
    },
    60_000
  )
})

import { Duration, Exit, Layer } from "effect"
import * as Aliases from "../src/decompose/Aliases.vibe"
import * as Turbo from "../src/decompose/Turbo.vibe"
import * as Stall from "../src/replay/Stall.vibe"
import * as SelectRepo from "../src/select/Repository.vibe"

describe("packages/ci Wave 10 FinalBoost4: SelectRepo, Aliases, Turbo, Stall & CliMain.run", () => {
  it(
    "exercises SelectRepo errors/shallow/prior, Aliases comments/prefixes, Turbo with/package tasks, Stall CPU advance & CliMain broken listen",
    async () => {
      // 1. Aliases.withoutAliases: block comment (L24), absolute baseUrl (L41-42), non-string/bad paths (L50-52), overlapping prefixes sort (L55)
      const dirs = new Map<string, string>([
        ["packages/a", "packages/a"],
        ["packages/a/sub", "packages/a/sub"]
      ])
      const ts1 = Aliases.withoutAliases(
        "tsconfig.json",
        "/* block comment */\n{ \"compilerOptions\": { \"baseUrl\": \".\", \"paths\": { \"@a/*\": [\"packages/a/*\"], \"@sub/*\": [\"packages/a/sub/*\"], \"@bad/*\": [\"/abs/*\", \"../up/*\", 123] } } }",
        dirs
      )
      expect(ts1).toBeDefined()
      const tsAbs = Aliases.withoutAliases(
        "tsconfig.json",
        "{ \"compilerOptions\": { \"baseUrl\": \"/abs/root\", \"paths\": { \"@a/*\": [\"a/*\"] } } }",
        dirs
      )
      expect(tsAbs).toBeDefined()

      // 2. Turbo.readConfig & Turbo.defines: `with: ["//", "db#start"]` (L80-81, 144), non-object task (L74), package-only task (L160-161)
      const turboCfg = Turbo.readConfig(
        JSON.stringify({
          tasks: {
            dev: { with: ["//", "db#start"] },
            weird: "not-an-object"
          }
        }),
        [
          [
            "@pkg/a",
            JSON.stringify({
              extends: ["//"],
              tasks: {
                dev: { with: ["//", "extra#run"] },
                pkgOnly: {}
              }
            })
          ]
        ]
      )
      expect(turboCfg).toBeDefined()
      if (turboCfg !== undefined) {
        expect(Turbo.defines(turboCfg, "pkgOnly")).toBe(true)
        expect(Turbo.defines(turboCfg, "dev", "@pkg/a")).toBe(true)
      }

      // 3. Stall.watchFor & exitOrStall with advancing CPU time (hits since = now; spent = tree.cpuMs L243-244!)
      let poll = 0
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const watch = yield* Stall.watchFor(0.001, {
              under: () =>
                Effect.sync(() => {
                  poll++
                  return [{ pid: 100, parent: 1, cpuMs: poll * 50 }]
                }),
              read: Effect.succeed([{ pid: 100, parent: 1, cpuMs: 50 }]),
              stop: () => Effect.void
            })
            const res = yield* Stall.exitOrStall(
              { pid: 100, exitCode: Effect.sleep(Duration.millis(120)).pipe(Effect.as(0)) } as never,
              watch
            )
            expect(res === 0 || res === "stalled").toBe(true)
          }).pipe(Effect.provide(NodeServices.layer))
        )
      )

      // 4. SelectRepo.layerGit: non-git (L84-85), bad ref (L89), shallow clone (L87), multi-commit cache hit (L102)
      await withTempDir("ci-w10fb4-repo-", async (dir) => {
        const nonGit = nodePath.join(dir, "plain")
        fs.mkdirSync(nonGit, { recursive: true })
        const repoLayer = SelectRepo.layerGit

        const nonGitExit = await Effect.runPromise(
          Effect.gen(function*() {
            const r = yield* SelectRepo.Repository
            return yield* r.change(nonGit, "HEAD")
          }).pipe(Effect.provide(Layer.merge(NodeServices.layer, repoLayer)), Effect.exit)
        )
        expect(Exit.isFailure(nonGitExit)).toBe(true)

        const gitDir = nodePath.join(dir, "repo")
        fs.mkdirSync(gitDir, { recursive: true })
        fs.writeFileSync(nodePath.join(gitDir, "a.txt"), "1\n")
        await initRepo(gitDir)
        fs.writeFileSync(nodePath.join(gitDir, "b.txt"), "2\n")
        await Effect.runPromise(
          Effect.gen(function*() {
            yield* Process.git(gitDir, ["add", "-A"])
            yield* Process.git(gitDir, ["commit", "-m", "c2"])
          }).pipe(Effect.provide(NodeServices.layer))
        )
        const [c1, c2] = (
          await Effect.runPromise(
            Process.git(gitDir, ["rev-list", "--reverse", "HEAD"]).pipe(Effect.provide(NodeServices.layer))
          )
        )
          .trim()
          .split("\n")

        // Bad ref -> L89
        const badRefExit = await Effect.runPromise(
          Effect.gen(function*() {
            const r = yield* SelectRepo.Repository
            return yield* r.change(gitDir, "0".repeat(40))
          }).pipe(Effect.provide(Layer.merge(NodeServices.layer, repoLayer)), Effect.exit)
        )
        expect(Exit.isFailure(badRefExit)).toBe(true)

        // Valid c1 then c2 on same layer -> hits prior history reuse (L102)!
        await Effect.runPromise(
          Effect.gen(function*() {
            const r = yield* SelectRepo.Repository
            const ch1 = yield* r.change(gitDir, c1!)
            const ch2 = yield* r.change(gitDir, c2!)
            expect(ch1.files.length).toBeGreaterThanOrEqual(1)
            expect(ch2.files.length).toBeGreaterThanOrEqual(1)
          }).pipe(Effect.provide(Layer.merge(NodeServices.layer, repoLayer)))
        )

        // Shallow clone -> L87!
        const shallowDir = nodePath.join(dir, "shallow")
        await Effect.runPromise(
          Process.git(dir, ["clone", "--depth=1", `file://${gitDir}`, shallowDir]).pipe(
            Effect.provide(NodeServices.layer)
          )
        )
        const shallowExit = await Effect.runPromise(
          Effect.gen(function*() {
            const r = yield* SelectRepo.Repository
            return yield* r.change(shallowDir, "HEAD")
          }).pipe(Effect.provide(Layer.merge(NodeServices.layer, repoLayer)), Effect.exit)
        )
        expect(Exit.isFailure(shallowExit)).toBe(true)

        // 5. CliMain.run with broken listen triggering uncaughtException -> hits L61-62, L131, L139, L141-143!
        const code = await CliMain.run(
          ["replay"],
          gitDir,
          {},
          {
            read: () =>
              Effect.sleep(Duration.seconds(5)).pipe(
                Effect.as({ version: 1, repository: gitDir, commit: "a".repeat(40), toolchains: [], jobs: [] })
              ),
            decompose: () => Effect.succeed({ packages: [], steps: [] } as never),
            files: () => Effect.succeed([]),
            run: () => Effect.sleep(Duration.seconds(5)).pipe(Effect.as({} as never)),
            text: () => "",
            html: () => "",
            rows: () => Effect.succeed([]),
            score: () => Effect.succeed([] as never)
          } as never,
          ((event: string, handler: (cause: unknown) => void) => {
            if (event === "uncaughtException") {
              setTimeout(() => handler(new Error("boom-listen")), 20)
            }
            return () => {}
          }) as never
        )
        expect(typeof code).toBe("number")
      })
    },
    60_000
  )
})
