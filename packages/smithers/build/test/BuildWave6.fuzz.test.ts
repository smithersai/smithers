import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Graph } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, FileSystem, Layer, Logger, Result, Schema, Stream } from "effect"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { describe, expect, it } from "vitest"
import { Install, PackageManager, Runtime } from "../src/index.ts"
import * as BunInternal from "../src/internal/bun.ts"
import * as Validate from "../src/internal/validate.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261260")

const assertPassed = (report: Parameters<typeof Fuzz.formatReport>[0]) => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const enc = new TextEncoder()
const sha = (ch: string) => ch.repeat(64)

const makeSpawner = (
  handler: (cmd: Parameters<Parameters<typeof ChildProcessSpawner.make>[0]>[0]) => Effect.Effect<{ stdout: Uint8Array; exitCode: number; delayMs?: number }, unknown>
): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((cmd) =>
      Effect.gen(function*() {
        const res = yield* handler(cmd).pipe(
          Effect.mapError((cause) => cause as never)
        )
        const delayedExit = res.delayMs !== undefined && res.delayMs > 0
          ? Effect.sleep(res.delayMs).pipe(Effect.as(ChildProcessSpawner.ExitCode(res.exitCode)))
          : Effect.succeed(ChildProcessSpawner.ExitCode(res.exitCode))
        return {
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: delayedExit,
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: undefined as never,
          stdout: res.delayMs !== undefined && res.delayMs > 0
            ? Stream.fromEffect(Effect.sleep(res.delayMs).pipe(Effect.as(res.stdout)))
            : Stream.make(res.stdout),
          stderr: Stream.empty,
          all: Stream.make(res.stdout),
          getInputFd: () => undefined as never,
          getOutputFd: () => Stream.empty
        } as unknown as ChildProcessSpawner.ChildProcessHandle
      })
    )
  )

describe("@smthrs/build Wave-6 deep security, lifecycle & edge-case fuzz invariants", () => {
  it("Runtime prerelease ordering, option validation, layerNode/layerBun & probe timeouts", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        preA: Schema.Literals(["alpha.1", "alpha.2", "alpha.10", "alpha.beta", "alpha", "99999999999999999999999", "100000000000000000000000", "0.1", "beta.1.2"]),
        preB: Schema.Literals(["alpha.1", "alpha.2", "alpha.10", "alpha.beta", "alpha", "99999999999999999999999", "100000000000000000000000", "0.1", "beta.1"]),
        badOpt: Schema.Literals(["req_empty", "exec_empty", "timeout_zero", "timeout_huge", "version_empty", "unsupported_req"]),
        rtName: Schema.Literals(["node", "bun"]),
        timeoutCase: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ preA, preB, badOpt, rtName, timeoutCase }) =>
          Effect.gen(function*() {
            const vA = `1.0.0-${preA}`
            const vB = `1.0.0-${preB}`
            if (Runtime.satisfies(`>=${vA}`, "1.0.0") !== true) return false
            if (Runtime.satisfies(`>${vA}`, "1.0.0") !== true) return false
            if (Runtime.satisfies(`<=${vA}`, "1.0.0") !== false) return false
            if (Runtime.satisfies(`=${vA}`, vA) !== true) return false
            const leAB = Runtime.satisfies(`<=${vB}`, vA)
            const geAB = Runtime.satisfies(`>=${vB}`, vA)
            if (typeof leAB !== "boolean" || typeof geAB !== "boolean") return false
            if (!leAB && !geAB) return false
            if (preA === preB && !(leAB && geAB)) return false

            const platform = { os: "linux", arch: "x64", libc: "glibc" } as const
            if (badOpt === "unsupported_req") {
              const noop = Runtime.makeNoop(rtName, { requirement: "^24.0.0", version: "24.0.0", platform })
              const res = yield* Effect.result(noop.verify)
              if (Result.isSuccess(res) || res.failure.code !== "unsupported_requirement") return false
            } else {
              let threw = false
              try {
                if (badOpt === "req_empty") {
                  Runtime.makeNoop(rtName, { requirement: "", version: "24.0.0", platform })
                } else if (badOpt === "exec_empty") {
                  Runtime.makeNoop(rtName, { requirement: "24.0.0", executable: "", version: "24.0.0", platform })
                } else if (badOpt === "timeout_zero") {
                  Runtime.makeNoop(rtName, { requirement: "24.0.0", probeTimeoutMs: 0, version: "24.0.0", platform })
                } else if (badOpt === "timeout_huge") {
                  Runtime.makeNoop(rtName, { requirement: "24.0.0", probeTimeoutMs: 999_999, version: "24.0.0", platform })
                } else {
                  Runtime.makeNoop(rtName, { requirement: "24.0.0", version: "", platform })
                }
              } catch (e) {
                threw = e instanceof TypeError
              }
              if (!threw) return false
            }

            const layer = rtName === "node"
              ? Runtime.layerNode({
                requirement: ">=20.0.0",
                platform,
                probeTimeoutMs: timeoutCase ? 10 : 5_000
              })
              : Runtime.layerBun({
                requirement: ">=1.0.0",
                platform,
                probeTimeoutMs: timeoutCase ? 10 : 5_000
              })
            const spawner = makeSpawner(() =>
              Effect.succeed({
                stdout: enc.encode(rtName === "node" ? "v24.1.0\n" : "1.2.3\n"),
                exitCode: 0,
                delayMs: timeoutCase ? 60 : 0
              })
            )
            const verified = yield* Effect.gen(function*() {
              const rt = yield* Runtime.Runtime
              return yield* rt.verify
            }).pipe(Effect.provide(layer), Effect.provide(spawner), Effect.result)

            if (timeoutCase) {
              if (Result.isSuccess(verified) || verified.failure.code !== "probe_failed") return false
            } else {
              if (Result.isFailure(verified)) return false
            }
            return true
          }).pipe(Effect.provide(Logger.layer([]))),
        { seed, executions: Math.min(executions, 45) }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("Validate & BunInternal enforce strict UTF-8, environment boundaries, bun.lock & bunfig.toml security rules", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        validateCase: Schema.Literals([
          "proxy_throw",
          "non_plain_null",
          "non_plain_date",
          "surrogate_valid_and_lone",
          "env_non_object",
          "env_too_many",
          "env_symbol",
          "env_getter",
          "env_non_string",
          "env_too_large",
          "env_win_dup"
        ]),
        bunLockCase: Schema.Literals([
          "bad_tables",
          "too_many_workspaces",
          "bad_patch_path",
          "patch_bad_suffix",
          "missing_pkg_id",
          "workspace_outside",
          "valid_workspace_and_patch"
        ]),
        bunfigCase: Schema.Literals([
          "invalid_toml",
          "non_table_install",
          "dollar_value",
          "dollar_key",
          "token_key",
          "url_cred",
          "dryRun_true",
          "offline_true",
          "cache_false",
          "cache_disable",
          "cache_unknown",
          "lockfile_print",
          "lockfile_unknown",
          "security_scanner",
          "cafile_with_cred",
          "registry_http_with_cred",
          "registry_bad_type",
          "scopes_non_table",
          "scopes_http_with_cred",
          "unknown_install_key",
          "valid_full"
        ]),
        cred: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ validateCase, bunLockCase, bunfigCase, cred }) =>
          Effect.sync(() => {
            if (validateCase === "surrogate_valid_and_lone") {
              const emoji = "a\u00e9\u2603\uD83D\uDE00"
              if (!Validate.isWellFormedText(emoji)) return false
              if (Validate.utf8ByteLength(emoji) !== new TextEncoder().encode(emoji).byteLength) return false
              const loneHigh = "x\uD800y"
              if (Validate.isWellFormedText(loneHigh)) return false
              if (Validate.utf8ByteLength(loneHigh) !== new TextEncoder().encode(loneHigh).byteLength) return false
              const loneLow = "x\uDC00"
              if (Validate.isWellFormedText(loneLow)) return false
            } else {
              let threw = false
              try {
                if (validateCase === "proxy_throw") {
                  const hostile = new Proxy({}, { getPrototypeOf() { throw new Error("boom") } })
                  Validate.plainRecord(hostile, "x")
                } else if (validateCase === "non_plain_null") {
                  Validate.plainRecord(null, "x")
                } else if (validateCase === "non_plain_date") {
                  Validate.plainRecord(new Date(), "x")
                } else if (validateCase === "env_non_object") {
                  Validate.normalizeEnvironment("bad", false, "env")
                } else if (validateCase === "env_too_many") {
                  const big: Record<string, string> = {}
                  for (let i = 0; i < 4100; i++) big[`K_${i}`] = "1"
                  Validate.normalizeEnvironment(big, false, "env")
                } else if (validateCase === "env_symbol") {
                  Validate.normalizeEnvironment({ [Symbol("s")]: "1" }, false, "env")
                } else if (validateCase === "env_getter") {
                  const obj: Record<string, unknown> = {}
                  Object.defineProperty(obj, "FOO", { get: () => "1", enumerable: true })
                  Validate.normalizeEnvironment(obj, false, "env")
                } else if (validateCase === "env_non_string") {
                  Validate.normalizeEnvironment({ FOO: 123 }, false, "env")
                } else if (validateCase === "env_too_large") {
                  Validate.normalizeEnvironment({ BIG: "a".repeat(300_000) }, false, "env")
                } else if (validateCase === "env_win_dup") {
                  Validate.normalizeEnvironment({ Path: "C:\\a", PATH: "C:\\b" }, true, "env")
                }
              } catch (e) {
                threw = e instanceof TypeError
              }
              if (!threw) return false
            }

            let lockText: string
            let expectLockOk = false
            if (bunLockCase === "bad_tables") {
              lockText = JSON.stringify({ lockfileVersion: 1, workspaces: { "": {} }, patchedDependencies: "nope", packages: {} })
            } else if (bunLockCase === "too_many_workspaces") {
              const ws: Record<string, object> = { "": {} }
              for (let i = 0; i < 4100; i++) ws[`p/m${i}`] = {}
              lockText = JSON.stringify({ lockfileVersion: 1, workspaces: ws, packages: {} })
            } else if (bunLockCase === "bad_patch_path") {
              lockText = JSON.stringify({ lockfileVersion: 1, workspaces: { "": {} }, patchedDependencies: { a: "../evil.patch" }, packages: {} })
            } else if (bunLockCase === "patch_bad_suffix") {
              lockText = JSON.stringify({ lockfileVersion: 1, workspaces: { "": {} }, patchedDependencies: { a: "patches/a.txt" }, packages: {} })
            } else if (bunLockCase === "missing_pkg_id") {
              lockText = JSON.stringify({ lockfileVersion: 1, workspaces: { "": {} }, packages: { a: [123] } })
            } else if (bunLockCase === "workspace_outside") {
              lockText = JSON.stringify({ lockfileVersion: 1, workspaces: { "": {} }, packages: { a: ["a@workspace:pkgs/missing"] } })
            } else {
              expectLockOk = true
              lockText = JSON.stringify({
                lockfileVersion: 1,
                workspaces: { "": {}, "pkgs/a": {} },
                patchedDependencies: { "foo@1.0.0": "patches/foo.patch" },
                packages: { a: ["a@workspace:pkgs/a"], foo: ["foo@1.0.0"] }
              })
            }
            const lockRes = BunInternal.readLockfile(lockText)
            const lockOk = !("_tag" in lockRes && lockRes._tag === "Refusal"); if (expectLockOk !== lockOk) return false

            const bunfigSamples: Record<typeof bunfigCase, { toml: string; mustRefuse: boolean }> = {
              invalid_toml: { toml: "[install\nbroken = =", mustRefuse: true },
              non_table_install: { toml: "install = 42\n", mustRefuse: true },
              dollar_value: { toml: "[install]\nregistry = \"https://$HOST/npm\"\n", mustRefuse: true },
              dollar_key: { toml: "[install.scopes]\n\"$BAD\" = \"https://r.example\"\n", mustRefuse: true },
              token_key: { toml: "[install.registry]\nurl = \"https://r.example\"\ntoken = \"abc\"\n", mustRefuse: true },
              url_cred: { toml: "[install]\nregistry = \"https://user:pass@r.example\"\n", mustRefuse: true },
              dryRun_true: { toml: "[install]\ndryRun = true\n", mustRefuse: true },
              offline_true: { toml: "[install]\noffline = true\n", mustRefuse: true },
              cache_false: { toml: "[install]\ncache = false\n", mustRefuse: true },
              cache_disable: { toml: "[install.cache]\ndisable = true\n", mustRefuse: true },
              cache_unknown: { toml: "[install.cache]\nweird = 1\n", mustRefuse: true },
              lockfile_print: { toml: "[install.lockfile]\nprint = \"yarn\"\n", mustRefuse: true },
              lockfile_unknown: { toml: "[install.lockfile]\nfoo = true\n", mustRefuse: true },
              security_scanner: { toml: "[install.security]\nscanner = \"x\"\n", mustRefuse: true },
              cafile_with_cred: { toml: "[install]\ncafile = \"ca.pem\"\n", mustRefuse: cred },
              registry_http_with_cred: { toml: "[install]\nregistry = \"http://registry.example\"\n", mustRefuse: cred },
              registry_bad_type: { toml: "[install]\nregistry = 123\n", mustRefuse: true },
              scopes_non_table: { toml: "[install]\nscopes = \"bad\"\n", mustRefuse: true },
              scopes_http_with_cred: { toml: "[install.scopes]\n\"@org\" = { url = \"http://r.example\" }\n", mustRefuse: cred },
              unknown_install_key: { toml: "[install]\nunknownSetting = true\n", mustRefuse: true },
              valid_full: {
                toml: "[install]\ndryRun = false\noffline = false\nregistry = \"https://registry.npmjs.org\"\n[install.cache]\ndisable = false\n[install.lockfile]\nsave = true\n[install.scopes]\n\"@acme\" = { url = \"https://registry.npmjs.org\" }\n",
                mustRefuse: false
              }
            }
            const sample = bunfigSamples[bunfigCase]
            const bunfigRefusal = BunInternal.checkBunfig(sample.toml, cred)
            if (sample.mustRefuse && bunfigRefusal === undefined) return false
            if (!sample.mustRefuse && bunfigRefusal !== undefined) return false

            return true
          }),
        { seed: seed + 1, executions: Math.min(executions, 120) }
      )
    )
    assertPassed(report)
  })

  it("Install flow graph, contract verification, drift detection & full executeLink lifecycle", async () => {
    const tmpBase = await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-build-w6-inst-"))
    try {
      const arb = Arbitrary.schema(
        Schema.Struct({
          managerName: Schema.Literals(["pnpm", "bun"]),
          scenario: Schema.Literals([
            "happy_link",
            "bad_manager_name",
            "bad_contract_store",
            "runtime_verify_fail",
            "store_platform_mismatch",
            "lockfile_drift_pre_link",
            "patch_drift_pre_link",
            "package_json_drift_during_link",
            "package_json_removed_during_link",
            "exists_error"
          ])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ managerName, scenario }) =>
            Effect.gen(function*() {
              const graph = Graph.build(Install.Install, { manager: managerName })
              if (graph.nodes.length < 3) return false

              const dir = yield* Effect.promise(() => Fs.mkdtemp(Path.join(tmpBase, "proj-")))
              const lockName = managerName === "pnpm" ? "pnpm-lock.yaml" : "bun.lock"
              yield* Effect.promise(async () => {
                await Fs.writeFile(Path.join(dir, "package.json"), JSON.stringify({ name: "app", version: "1.0.0" }))
                await Fs.writeFile(
                  Path.join(dir, lockName),
                  managerName === "pnpm"
                    ? "lockfileVersion: '9.0'\n"
                    : JSON.stringify({
                      lockfileVersion: 1,
                      workspaces: { "": { name: "app" } },
                      patchedDependencies: { "foo@1.0.0": "patches/foo.patch" },
                      packages: {}
                    })
                )
                if (managerName === "pnpm") {
                  await Fs.writeFile(Path.join(dir, ".pnpmfile.cjs"), "module.exports = {}\n")
                  await Fs.writeFile(Path.join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'pkgs/*'\n")
                } else {
                  await Fs.mkdir(Path.join(dir, "patches"), { recursive: true })
                  await Fs.writeFile(Path.join(dir, "patches", "foo.patch"), "diff --git a/x b/x\n")
                  await Fs.writeFile(Path.join(dir, "bunfig.toml"), "[install]\ndryRun = false\n")
                }
              })

              const platform = { os: "linux", arch: "x64", libc: "glibc" } as const
              const runtime = Runtime.makeNoop(managerName === "pnpm" ? "node" : "bun", {
                requirement: scenario === "runtime_verify_fail" ? ">=99.0.0" : ">=1.0.0",
                version: "24.0.0",
                platform
              })

              const managerVersion = managerName === "pnpm" ? "10.0.0" : "1.2.0"
              const baseManager: PackageManager.Service = {
                name: (scenario === "bad_manager_name" ? "yarn" : managerName) as PackageManager.Name,
                projectRoot: dir,
                requirement: managerVersion,
                lockfileName: lockName,
                storeDirectory: scenario === "bad_contract_store"
                  ? ".smithers/wrong"
                  : `${PackageManager.storeRoot}/${managerName}`,
                platformSensitive: managerName === "bun",
                version: Effect.succeed(managerVersion),
                verify: Effect.succeed(managerVersion),
                fetch: Effect.void,
                link: Effect.promise(async () => {
                  if (scenario === "package_json_drift_during_link") {
                    await Fs.writeFile(Path.join(dir, "package.json"), JSON.stringify({ name: "app", version: "2.0.0" }))
                  } else if (scenario === "package_json_removed_during_link") {
                    await Fs.rm(Path.join(dir, "package.json"), { force: true })
                  }
                }),
                linkManifest: Effect.succeed(sha("c") as never)
              }

              const baseLayer = Layer.mergeAll(
                NodeFileSystem.layer,
                NodeCrypto.layer,
                NodePath.layer,
                Logger.layer([]),
                Layer.succeed(PackageManager.PackageManager, baseManager),
                Layer.succeed(Runtime.Runtime, runtime)
              )

              if (scenario === "exists_error") {
                const faultyFsLayer = Layer.effect(
                  FileSystem.FileSystem,
                  Effect.map(FileSystem.FileSystem, (real) => ({
                    ...real,
                    exists: () => Effect.fail({ _tag: "SystemError", reason: "PermissionDenied", message: "denied" } as never)
                  }))
                ).pipe(Layer.provide(NodeFileSystem.layer))
                const res = yield* Install.executeMeasure().pipe(
                  Effect.provide(Layer.mergeAll(
                    faultyFsLayer,
                    NodeCrypto.layer,
                    Logger.layer([]),
                    Layer.succeed(PackageManager.PackageManager, {
                      ...baseManager,
                      name: managerName,
                      storeDirectory: `${PackageManager.storeRoot}/${managerName}`
                    })
                  )),
                  Effect.result
                )
                return Result.isFailure(res) && (res.failure.code === "manifest_unreadable" || res.failure.code === "lockfile_unreadable")
              }

              if (scenario === "bad_manager_name" || scenario === "bad_contract_store" || scenario === "runtime_verify_fail") {
                const measured = yield* Install.executeMeasure().pipe(
                  Effect.provide(Layer.mergeAll(
                    NodeFileSystem.layer,
                    NodeCrypto.layer,
                    Logger.layer([]),
                    Layer.succeed(PackageManager.PackageManager, {
                      ...baseManager,
                      name: managerName,
                      storeDirectory: `${PackageManager.storeRoot}/${managerName}`
                    })
                  ))
                )
                const fetched = yield* Install.executeFetch({ content: measured }).pipe(
                  Effect.provide(baseLayer),
                  Effect.result
                )
                return Result.isFailure(fetched) && fetched.failure.code === "environment_mismatch"
              }

              const measured = yield* Install.executeMeasure().pipe(Effect.provide(baseLayer))
              const store = yield* Install.executeFetch({ content: measured }).pipe(Effect.provide(baseLayer))

              if (scenario === "store_platform_mismatch") {
                const mismatched = { ...store, platform: { os: "darwin", arch: "arm64", libc: null } }
                const linked = yield* Install.executeLink({ content: measured, store: mismatched }).pipe(
                  Effect.provide(baseLayer),
                  Effect.result
                )
                return Result.isFailure(linked) && linked.failure.code === "environment_mismatch"
              }

              if (scenario === "lockfile_drift_pre_link") {
                yield* Effect.promise(() => Fs.appendFile(Path.join(dir, lockName), "\n"))
                const linked = yield* Install.executeLink({ content: measured, store }).pipe(
                  Effect.provide(baseLayer),
                  Effect.result
                )
                return Result.isFailure(linked) && linked.failure.code === "input_drift"
              }

              if (scenario === "patch_drift_pre_link") {
                if (managerName === "bun") {
                  yield* Effect.promise(() => Fs.appendFile(Path.join(dir, "patches", "foo.patch"), "+extra\n"))
                } else {
                  yield* Effect.promise(() => Fs.appendFile(Path.join(dir, ".pnpmfile.cjs"), "\n// drifted\n"))
                }
                const linked = yield* Install.executeLink({ content: measured, store }).pipe(
                  Effect.provide(baseLayer),
                  Effect.result
                )
                return Result.isFailure(linked) && linked.failure.code === "input_drift"
              }

              const linked = yield* Install.executeLink({ content: measured, store }).pipe(
                Effect.provide(baseLayer),
                Effect.result
              )
              if (scenario === "happy_link") {
                return Result.isSuccess(linked) && linked.success.linked === true && linked.success.store === store.digest
              }
              return Result.isFailure(linked) && linked.failure.code === "input_drift"
            }),
          { seed: seed + 2, executions: Math.min(executions, 40) }
        )
      )
      assertPassed(report)
    } finally {
      await Fs.rm(tmpBase, { recursive: true, force: true })
    }
  }, 60_000)

  it("PackageManager options, manifests, npmrc/workspace security, win32 shims & Bun store lifecycle", async () => {
    const tmpBase = await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-build-w6-pm-"))
    try {
      const arb = Arbitrary.schema(
        Schema.Struct({
          validationCase: Schema.Literals([
            "bad_manager_noop",
            "bad_timeout",
            "bad_cred_hosts_not_array",
            "bad_cred_host_entry",
            "bad_store_relative",
            "bad_store_inside_root",
            "manifest_bad_manager",
            "manifest_bad_version",
            "manifest_bad_lock_digest",
            "manifest_bad_npmrc_digest",
            "manifest_bad_opt_digest",
            "manifest_bad_patch_entry",
            "linked_manifest_bad_digest"
          ]),
          npmrcCase: Schema.Literals([
            "quoted_json_escape",
            "unquoted_escapes_and_comment",
            "workspace_placeholder",
            "cred_host_denied",
            "cred_http_registry",
            "cred_workspace_bad_yaml",
            "cred_workspace_seq_key",
            "cred_workspace_transport",
            "cred_unsafe_env_ref",
            "path_sanitization"
          ]),
          winShimCase: Schema.Literals([
            "valid_shim",
            "multi_entry",
            "dir_shim",
            "missing_entry",
            "no_shim"
          ]),
          bunCase: Schema.Literals([
            "missing_lock_no_lockb",
            "missing_lock_with_lockb",
            "custom_store_and_cache_hit_and_invalidation",
            "store_parent_package_json",
            "env_file_reserved_and_dir",
            "link_nonempty_home",
            "link_manifest_tree",
            "symlink_bunfig_refused",
            "capture_bad_output_and_timeout"
          ])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ validationCase, npmrcCase, winShimCase, bunCase }) =>
            Effect.gen(function*() {
              const platform = { os: "linux", arch: "x64", libc: "glibc" } as const
              const dir = yield* Effect.promise(() => Fs.mkdtemp(Path.join(tmpBase, "pm-")))

              if (validationCase === "linked_manifest_bad_digest") {
                const exit = yield* PackageManager.linkedTreeManifest({
                  storeDigest: "not-a-digest" as never,
                  packageJsonDigest: sha("a") as never,
                  managerEvidence: sha("b") as never
                }).pipe(Effect.provide(NodeCrypto.layer), Effect.exit)
                if (exit._tag !== "Failure") return false
              } else if (validationCase === "manifest_bad_manager" || validationCase === "manifest_bad_version" || validationCase === "manifest_bad_lock_digest" || validationCase === "manifest_bad_npmrc_digest" || validationCase === "manifest_bad_opt_digest" || validationCase === "manifest_bad_patch_entry") {
                const exit = yield* PackageManager.storeManifest({
                  manager: (validationCase === "manifest_bad_manager" ? "yarn" : "pnpm") as PackageManager.Name,
                  managerVersion: validationCase === "manifest_bad_version" ? "10.0.0\nbad" : "10.0.0",
                  platform: null,
                  lockfileDigest: validationCase === "manifest_bad_lock_digest" ? "bad" : sha("a"),
                  npmrcDigest: validationCase === "manifest_bad_npmrc_digest" ? "bad" : null,
                  pnpmfileDigest: validationCase === "manifest_bad_opt_digest" ? "bad" : null,
                  patches: validationCase === "manifest_bad_patch_entry"
                    ? [{ path: "", digest: "bad" }]
                    : [{ path: "patches/a.patch", digest: sha("d") }]
                }).pipe(Effect.provide(NodeCrypto.layer), Effect.exit)
                if (exit._tag !== "Failure") return false
              } else {
                let threw = false
                try {
                  if (validationCase === "bad_manager_noop") {
                    PackageManager.makeNoop("yarn" as PackageManager.Name, { projectRoot: dir, requirement: "10.0.0" }, platform)
                  } else if (validationCase === "bad_timeout") {
                    PackageManager.makeNoop("pnpm", { projectRoot: dir, requirement: "10.0.0", timeoutMs: 0 }, platform)
                  } else if (validationCase === "bad_cred_hosts_not_array") {
                    PackageManager.makeNoop("pnpm", { projectRoot: dir, requirement: "10.0.0", credentialHosts: "bad" as never }, platform)
                  } else if (validationCase === "bad_cred_host_entry") {
                    PackageManager.makeNoop("pnpm", { projectRoot: dir, requirement: "10.0.0", credentialHosts: ["not a host!"] }, platform)
                  } else if (validationCase === "bad_store_relative") {
                    PackageManager.makeNoop("pnpm", { projectRoot: dir, requirement: "10.0.0", storeDirectory: "relative/store" }, platform)
                  } else if (validationCase === "bad_store_inside_root") {
                    PackageManager.makeNoop("pnpm", { projectRoot: dir, requirement: "10.0.0", storeDirectory: `${dir}/inside` }, platform)
                  }
                } catch (e) {
                  threw = e instanceof TypeError
                }
                if (!threw) return false
              }

              const pnpmDir = yield* Effect.promise(() => Fs.mkdtemp(Path.join(tmpBase, "pnpm-")))
              yield* Effect.promise(async () => {
                await Fs.writeFile(Path.join(pnpmDir, "package.json"), JSON.stringify({ name: "p" }))
                await Fs.writeFile(Path.join(pnpmDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
              })

              let expectUnsafe = true
              const credHosts: ReadonlyArray<string> = ["registry.npmjs.org"]
              let envMap: Record<string, string> = { MY_TOKEN: "secret", NODE_OPTIONS: "--evil", PATH: ".:/usr/bin::relative/bin" }
              if (npmrcCase === "quoted_json_escape") {
                yield* Effect.promise(() =>
                  Fs.writeFile(Path.join(pnpmDir, ".npmrc"), '//registry.npmjs.org/:_authToken="\\u0024{MY_TOKEN}"\ntag=\'true\'\nbad=\'\\x\'\n')
                )
                expectUnsafe = false
              } else if (npmrcCase === "unquoted_escapes_and_comment") {
                yield* Effect.promise(() =>
                  Fs.writeFile(Path.join(pnpmDir, ".npmrc"), "tag=a\\#b\\;c\\d # trailing comment\n")
                )
                expectUnsafe = false
              } else if (npmrcCase === "workspace_placeholder") {
                yield* Effect.promise(() =>
                  Fs.writeFile(Path.join(pnpmDir, "pnpm-workspace.yaml"), "packages:\n  - '${EVIL}'\n")
                )
              } else if (npmrcCase === "cred_host_denied") {
                yield* Effect.promise(() =>
                  Fs.writeFile(Path.join(pnpmDir, ".npmrc"), "//evil.example/:_authToken=${MY_TOKEN}\n")
                )
              } else if (npmrcCase === "cred_http_registry") {
                yield* Effect.promise(() =>
                  Fs.writeFile(Path.join(pnpmDir, ".npmrc"), "//registry.npmjs.org/:_authToken=${MY_TOKEN}\nregistry=http://registry.npmjs.org\n")
                )
              } else if (npmrcCase === "cred_workspace_bad_yaml") {
                yield* Effect.promise(async () => {
                  await Fs.writeFile(Path.join(pnpmDir, ".npmrc"), "//registry.npmjs.org/:_authToken=${MY_TOKEN}\n")
                  await Fs.writeFile(Path.join(pnpmDir, "pnpm-workspace.yaml"), ":\n  - [unterminated\n")
                })
              } else if (npmrcCase === "cred_workspace_seq_key") {
                yield* Effect.promise(async () => {
                  await Fs.writeFile(Path.join(pnpmDir, ".npmrc"), "//registry.npmjs.org/:_authToken=${MY_TOKEN}\n")
                  await Fs.writeFile(Path.join(pnpmDir, "pnpm-workspace.yaml"), "? [proxy]\n: http://evil\n")
                })
              } else if (npmrcCase === "cred_workspace_transport") {
                yield* Effect.promise(async () => {
                  await Fs.writeFile(Path.join(pnpmDir, ".npmrc"), "//registry.npmjs.org/:_authToken=${MY_TOKEN}\n")
                  await Fs.writeFile(Path.join(pnpmDir, "pnpm-workspace.yaml"), "proxy: http://evil\n")
                })
              } else if (npmrcCase === "cred_unsafe_env_ref") {
                yield* Effect.promise(() =>
                  Fs.writeFile(Path.join(pnpmDir, ".npmrc"), "//registry.npmjs.org/:_authToken=${NODE_OPTIONS}\n")
                )
              } else if (npmrcCase === "path_sanitization") {
                envMap = { PATH: ".:relative:" }
                expectUnsafe = false
              }

              const okSpawner = makeSpawner(() => Effect.succeed({ stdout: enc.encode("10.1.0\n"), exitCode: 0 }))
              const pnpmRuntime = Runtime.makeNoop("node", { requirement: ">=20.0.0", version: "24.0.0", platform })
              const pnpmSvc = yield* PackageManager.makePnpm({
                projectRoot: pnpmDir,
                requirement: ">=10.0.0",
                environment: envMap,
                credentialHosts: credHosts
              }).pipe(
                Effect.provide(Layer.mergeAll(
                  NodeFileSystem.layer,
                  NodeCrypto.layer,
                  okSpawner,
                  Logger.layer([]),
                  Layer.succeed(Runtime.Runtime, pnpmRuntime)
                ))
              )
              const pnpmFetchRes = yield* pnpmSvc.fetch.pipe(Effect.result)
              if (expectUnsafe) {
                if (Result.isSuccess(pnpmFetchRes) || pnpmFetchRes.failure.code !== "unsafe_configuration") return false
              } else {
                if (Result.isFailure(pnpmFetchRes)) return false
              }

              const winDir = yield* Effect.promise(() => Fs.mkdtemp(Path.join(tmpBase, "win-")))
              const binDir = Path.join(winDir, "bin")
              yield* Effect.promise(() => Fs.mkdir(binDir, { recursive: true }))
              if (winShimCase === "valid_shim") {
                yield* Effect.promise(async () => {
                  await Fs.mkdir(Path.join(binDir, "dist"), { recursive: true })
                  await Fs.writeFile(Path.join(binDir, "dist", "pnpm.mjs"), "export {}\n")
                  await Fs.writeFile(Path.join(binDir, "pnpm.cmd"), '@echo off\r\n"%~dp0\\dist\\pnpm.mjs" %*\r\n')
                })
              } else if (winShimCase === "multi_entry") {
                yield* Effect.promise(() =>
                  Fs.writeFile(Path.join(binDir, "pnpm.cmd"), '"%~dp0\\a\\pnpm.cjs" %*\r\n"%~dp0\\b\\pnpm.mjs" %*\r\n')
                )
              } else if (winShimCase === "dir_shim") {
                yield* Effect.promise(() => Fs.mkdir(Path.join(binDir, "pnpm.cmd"), { recursive: true }))
              } else if (winShimCase === "missing_entry") {
                yield* Effect.promise(() => Fs.writeFile(Path.join(binDir, "pnpm.cmd"), '"%~dp0\\missing\\pnpm.cjs" %*\r\n'))
              }
              const winPlatform = { os: "win32", arch: "x64", libc: null } as const
              const winRt = Runtime.makeNoop("node", { requirement: ">=20.0.0", version: "24.0.0", platform: winPlatform, executable: "C:\\node.exe" })
              const winPnpm = yield* PackageManager.makePnpm({
                projectRoot: winDir,
                requirement: ">=10.0.0",
                environment: { PATH: `relative;"${binDir}"` }
              }).pipe(
                Effect.provide(Layer.mergeAll(
                  NodeFileSystem.layer,
                  NodeCrypto.layer,
                  okSpawner,
                  Logger.layer([]),
                  Layer.succeed(Runtime.Runtime, winRt)
                ))
              )
              const winVer = yield* winPnpm.version.pipe(Effect.result)
              if (winShimCase === "valid_shim") {
                if (Result.isFailure(winVer)) return false
              } else {
                if (Result.isSuccess(winVer) || winVer.failure.code !== "environment_mismatch") return false
              }

              const bunDir = yield* Effect.promise(() => Fs.mkdtemp(Path.join(tmpBase, "bun-")))
              const extStore = yield* Effect.promise(() => Fs.mkdtemp(Path.join(tmpBase, "bun-store-")))
              yield* Effect.promise(() => Fs.writeFile(Path.join(bunDir, "package.json"), JSON.stringify({ name: "b" })))
              const validBunLock = JSON.stringify({
                lockfileVersion: 1,
                workspaces: { "": { name: "b" } },
                patchedDependencies: { "foo@1.0.0": "patches/foo.patch" },
                packages: { foo: ["foo@1.0.0"] }
              })

              const bunRt = Runtime.makeNoop("bun", { requirement: ">=1.0.0", version: "1.4.2", platform })
              const bunSpawner = makeSpawner((cmd) => {
                if (bunCase === "capture_bad_output_and_timeout") {
                  const args = (cmd as unknown as { args?: ReadonlyArray<string> }).args ?? []
                  if (args.includes("--version")) {
                    return Effect.succeed({ stdout: enc.encode("1.4.2\nextra-line\n"), exitCode: 0 })
                  }
                  return Effect.succeed({ stdout: enc.encode(""), exitCode: 1 })
                }
                return Effect.succeed({ stdout: enc.encode("1.4.2\n"), exitCode: 0 })
              })
              const bunBaseLayer = Layer.mergeAll(
                NodeFileSystem.layer,
                NodeCrypto.layer,
                bunSpawner,
                Logger.layer([]),
                Layer.succeed(Runtime.Runtime, bunRt)
              )

              if (bunCase === "missing_lock_no_lockb" || bunCase === "missing_lock_with_lockb") {
                if (bunCase === "missing_lock_with_lockb") {
                  yield* Effect.promise(() => Fs.writeFile(Path.join(bunDir, "bun.lockb"), "bin"))
                }
                const res = yield* PackageManager.bunPatchDigests(bunDir).pipe(Effect.provide(bunBaseLayer), Effect.result)
                if (Result.isSuccess(res) || res.failure.code !== "lockfile_unreadable") return false
              } else if (bunCase === "custom_store_and_cache_hit_and_invalidation") {
                yield* Effect.promise(async () => {
                  await Fs.writeFile(Path.join(bunDir, "bun.lock"), validBunLock)
                  await Fs.mkdir(Path.join(bunDir, "patches"), { recursive: true })
                  await Fs.writeFile(Path.join(bunDir, "patches", "foo.patch"), "diff\n")
                  await Fs.writeFile(Path.join(bunDir, "bunfig.toml"), "[install]\ndryRun = false\n")
                })
                let fetchCalls = 0
                const countingSpawner = makeSpawner((cmd) => {
                  const args = (cmd as unknown as { args?: ReadonlyArray<string> }).args ?? []
                  if (args[0] === "install") fetchCalls += 1
                  return Effect.succeed({ stdout: enc.encode("1.4.2\n"), exitCode: 0 })
                })
                const bunSvc = yield* PackageManager.makeBun({
                  projectRoot: bunDir,
                  requirement: ">=1.0.0",
                  storeDirectory: extStore
                }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodeCrypto.layer, countingSpawner, Logger.layer([]), Layer.succeed(Runtime.Runtime, bunRt))))
                yield* bunSvc.fetch
                const firstCalls = fetchCalls
                yield* bunSvc.fetch
                if (fetchCalls !== firstCalls) return false
                yield* Effect.promise(() => Fs.rm(Path.join(bunDir, "bunfig.toml")))
                yield* bunSvc.fetch
                if (fetchCalls !== firstCalls + 1) return false
                const patches = yield* PackageManager.bunPatchDigests(bunDir).pipe(Effect.provide(bunBaseLayer))
                if (patches.length !== 1 || patches[0]!.path !== "patches/foo.patch") return false
              } else if (bunCase === "store_parent_package_json") {
                yield* Effect.promise(async () => {
                  await Fs.writeFile(Path.join(bunDir, "bun.lock"), validBunLock)
                  await Fs.mkdir(Path.join(bunDir, "patches"), { recursive: true })
                  await Fs.writeFile(Path.join(bunDir, "patches", "foo.patch"), "diff\n")
                  await Fs.writeFile(Path.join(extStore, "package.json"), "{}")
                })
                const bunSvc = yield* PackageManager.makeBun({
                  projectRoot: bunDir,
                  requirement: ">=1.0.0",
                  storeDirectory: extStore
                }).pipe(Effect.provide(bunBaseLayer))
                const res = yield* bunSvc.fetch.pipe(Effect.result)
                if (Result.isSuccess(res) || res.failure.code !== "unsafe_configuration") return false
              } else if (bunCase === "env_file_reserved_and_dir") {
                yield* Effect.promise(async () => {
                  await Fs.writeFile(Path.join(bunDir, "bun.lock"), validBunLock)
                  await Fs.mkdir(Path.join(bunDir, "patches"), { recursive: true })
                  await Fs.writeFile(Path.join(bunDir, "patches", "foo.patch"), "diff\n")
                  await Fs.mkdir(Path.join(bunDir, ".env"), { recursive: true })
                  await Fs.writeFile(Path.join(bunDir, ".env.local"), "BUN_INSTALL=/tmp/pwn\n")
                })
                const bunSvc = yield* PackageManager.makeBun({
                  projectRoot: bunDir,
                  requirement: ">=1.0.0",
                  storeDirectory: extStore
                }).pipe(Effect.provide(bunBaseLayer))
                const res = yield* bunSvc.fetch.pipe(Effect.result)
                if (Result.isSuccess(res) || res.failure.code !== "unsafe_configuration") return false
              } else if (bunCase === "link_nonempty_home") {
                yield* Effect.promise(async () => {
                  await Fs.writeFile(Path.join(bunDir, "bun.lock"), validBunLock)
                  await Fs.mkdir(Path.join(bunDir, "patches"), { recursive: true })
                  await Fs.writeFile(Path.join(bunDir, "patches", "foo.patch"), "diff\n")
                })
                const bunSvc = yield* PackageManager.makeBun({
                  projectRoot: bunDir,
                  requirement: ">=1.0.0",
                  storeDirectory: extStore
                }).pipe(Effect.provide(bunBaseLayer))
                yield* bunSvc.fetch
                yield* Effect.promise(() => Fs.writeFile(Path.join(extStore, "home", ".npmrc"), "evil=1\n"))
                const res = yield* bunSvc.link.pipe(Effect.result)
                if (Result.isSuccess(res) || res.failure.code !== "unsafe_configuration") return false
              } else if (bunCase === "link_manifest_tree") {
                yield* Effect.promise(async () => {
                  await Fs.mkdir(Path.join(bunDir, "node_modules", ".bun", "foo@1.0.0"), { recursive: true })
                  await Fs.mkdir(Path.join(bunDir, "node_modules", "@acme", "pkg"), { recursive: true })
                  await Fs.mkdir(Path.join(bunDir, "node_modules", "plain"), { recursive: true })
                })
                const bunSvc = yield* PackageManager.makeBun({
                  projectRoot: bunDir,
                  requirement: ">=1.0.0",
                  storeDirectory: extStore
                }).pipe(Effect.provide(bunBaseLayer))
                const m1 = yield* bunSvc.linkManifest.pipe(Effect.provide(NodeCrypto.layer))
                const m2 = yield* bunSvc.linkManifest.pipe(Effect.provide(NodeCrypto.layer))
                if (m1 !== m2 || m1.length !== 64) return false
              } else if (bunCase === "symlink_bunfig_refused") {
                const outsideFile = Path.join(extStore, "outside.toml")
                yield* Effect.promise(async () => {
                  await Fs.writeFile(outsideFile, "[install]\ndryRun = false\n")
                  await Fs.symlink(outsideFile, Path.join(bunDir, "bunfig.toml"))
                  await Fs.writeFile(Path.join(bunDir, "bun.lock"), validBunLock)
                  await Fs.mkdir(Path.join(bunDir, "patches"), { recursive: true })
                  await Fs.writeFile(Path.join(bunDir, "patches", "foo.patch"), "diff\n")
                })
                const bunSvc = yield* PackageManager.makeBun({
                  projectRoot: bunDir,
                  requirement: ">=1.0.0",
                  storeDirectory: extStore
                }).pipe(Effect.provide(bunBaseLayer))
                const res = yield* bunSvc.fetch.pipe(Effect.result)
                if (Result.isSuccess(res) || res.failure.code !== "manifest_unreadable") return false
              } else if (bunCase === "capture_bad_output_and_timeout") {
                const bunSvc = yield* PackageManager.makeBun({
                  projectRoot: bunDir,
                  requirement: ">=1.0.0",
                  storeDirectory: extStore
                }).pipe(Effect.provide(bunBaseLayer))
                const res = yield* bunSvc.version.pipe(Effect.result)
                if (Result.isSuccess(res) || res.failure.code !== "command_failed") return false
              }

              return true
            }),
          { seed: seed + 3, executions: Math.min(executions, 35) }
        )
      )
      assertPassed(report)
    } finally {
      await Fs.rm(tmpBase, { recursive: true, force: true })
    }
  }, 60_000)

  it("PackageManager.boundedBytes detects RegularFileOpen, symlink escape, TOCTOU identity/size/canonical drift & bad UTF-8", async () => {
    const tmpBase = await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-build-w6-io-"))
    try {
      const arb = Arbitrary.schema(
        Schema.Struct({
          fault: Schema.Literals([
            "regular_file_open_ok",
            "symlink_escape",
            "is_directory",
            "stat_identity_drift",
            "read_bad_length",
            "read_short",
            "after_stat_drift",
            "canonical_drift",
            "bad_utf8_npmrc"
          ])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ fault }) =>
            Effect.gen(function*() {
              const dir = yield* Effect.promise(() => Fs.mkdtemp(Path.join(tmpBase, "io-")))
              const target = Path.join(dir, "package.json")
              yield* Effect.promise(() => Fs.writeFile(target, "{\"name\":\"x\"}"))

              if (fault === "regular_file_open_ok") {
                const regLayer = Layer.effect(
                  PackageManager.RegularFileOpen,
                  Effect.map(FileSystem.FileSystem, (real) => ({
                    open: (p: string) => real.open(p, { flag: "r" })
                  }))
                ).pipe(Layer.provide(NodeFileSystem.layer))
                const digest = yield* PackageManager.packageJsonDigest(dir).pipe(
                  Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodeCrypto.layer, regLayer, Logger.layer([])))
                )
                return digest.length === 64
              }

              if (fault === "symlink_escape") {
                const ext = Path.join(tmpBase, "outside-pkg.json")
                yield* Effect.promise(async () => {
                  await Fs.writeFile(ext, "{}")
                  await Fs.rm(target)
                  await Fs.symlink(ext, target)
                })
                const res = yield* PackageManager.packageJsonDigest(dir).pipe(
                  Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodeCrypto.layer, Logger.layer([]))),
                  Effect.result
                )
                return Result.isFailure(res) && res.failure.code === "manifest_unreadable"
              }

              if (fault === "is_directory") {
                yield* Effect.promise(async () => {
                  await Fs.rm(target)
                  await Fs.mkdir(target)
                })
                const res = yield* PackageManager.packageJsonDigest(dir).pipe(
                  Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodeCrypto.layer, Logger.layer([]))),
                  Effect.result
                )
                return Result.isFailure(res) && res.failure.code === "manifest_unreadable"
              }

              if (fault === "bad_utf8_npmrc") {
                yield* Effect.promise(async () => {
                  await Fs.writeFile(Path.join(dir, ".npmrc"), new Uint8Array([0xff, 0xfe, 0x80]))
                  await Fs.writeFile(Path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
                })
                const platform = { os: "linux", arch: "x64", libc: "glibc" } as const
                const rt = Runtime.makeNoop("node", { requirement: ">=20.0.0", version: "24.0.0", platform })
                const sp = makeSpawner(() => Effect.succeed({ stdout: enc.encode("10.0.0\n"), exitCode: 0 }))
                const pm = yield* PackageManager.makePnpm({ projectRoot: dir, requirement: ">=10.0.0" }).pipe(
                  Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodeCrypto.layer, sp, Logger.layer([]), Layer.succeed(Runtime.Runtime, rt)))
                )
                const res = yield* pm.fetch.pipe(Effect.result)
                return Result.isFailure(res) && res.failure.code === "manifest_unreadable"
              }

              let realPathCalls = 0
              const faultyFs = Layer.effect(
                FileSystem.FileSystem,
                Effect.gen(function*() {
                  const real = yield* FileSystem.FileSystem
                  return FileSystem.makeNoop({
                    ...real,
                    realPath: (p: string) =>
                      Effect.gen(function*() {
                        const resolved = yield* real.realPath(p)
                        realPathCalls += 1
                        if (fault === "canonical_drift" && realPathCalls === 3) {
                          return `${resolved}-moved`
                        }
                        return resolved
                      }),
                    open: (p: string, opts?: Parameters<typeof real.open>[1]) =>
                      Effect.map(real.open(p, opts), (file) => {
                        let statCalls = 0
                        return {
                          ...file,
                          stat: Effect.map(file.stat, (info) => {
                            statCalls += 1
                            if (fault === "stat_identity_drift" && statCalls === 1) {
                              return { ...info, ino: 999_999_999 as unknown as typeof info.ino }
                            }
                            if (fault === "after_stat_drift" && statCalls === 2) {
                              return { ...info, ino: 888_888_888 as unknown as typeof info.ino }
                            }
                            return info
                          }),
                          read: (buf: Uint8Array) =>
                            Effect.map(file.read(buf), (n) =>
                              fault === "read_bad_length"
                                ? ((buf.byteLength + 10) as typeof n)
                                : fault === "read_short"
                                  ? (0 as typeof n)
                                  : n
                            )
                        }
                      })
                  })
                })
              ).pipe(Layer.provide(NodeFileSystem.layer))

              const res = yield* PackageManager.packageJsonDigest(dir).pipe(
                Effect.provide(Layer.mergeAll(faultyFs, NodeCrypto.layer, Logger.layer([]))),
                Effect.result
              )
              return Result.isFailure(res) && res.failure.code === "manifest_unreadable"
            }),
          { seed: seed + 4, executions: Math.min(executions, 30) }
        )
      )
      assertPassed(report)
    } finally {
      await Fs.rm(tmpBase, { recursive: true, force: true })
    }
  }, 60_000)
})
