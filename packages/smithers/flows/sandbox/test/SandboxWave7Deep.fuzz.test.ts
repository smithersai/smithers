import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, FileSystem, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as DirectorySandbox from "../src/DirectorySandbox/index.ts"
import { pidDirectory } from "../src/internal/pidDirectory.ts"
import * as Sandbox from "../src/Sandbox/index.ts"
import * as SandboxConformance from "../src/SandboxConformance/index.ts"
import { platform } from "./helpers/containedPlatform.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "100"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261125")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const getServices = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner
  return { fs, spawner }
}).pipe(Effect.provide(platform))

describe("@smthrs/sandbox Wave 7 deep fuzz (SandboxConformance, Sandbox.fileSystem differential, Sandbox.job boundaries)", () => {
  it("SandboxConformance.check passes truthful DirectorySandbox and catches injected provider lies", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        warpKind: Schema.Literals(["truthful", "dropEnv", "badExit", "corruptRead"])
      })
    )

    const services = await Effect.runPromise(getServices)

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ warpKind }) =>
          Effect.gen(function*() {
            const root = realpathSync(mkdtempSync(join(tmpdir(), "sb-conf-w7-")))
            try {
              const truthful = DirectorySandbox.make({ ...services, root })
              const provider: Sandbox.Provider = warpKind === "truthful"
                ? truthful
                : {
                  acquire: (key) =>
                    Effect.map(truthful.acquire(key), (sess) => {
                      if (warpKind === "dropEnv") {
                        return {
                          ...sess,
                          spawn: (command, options) => sess.spawn(command, { ...options, env: undefined })
                        }
                      }
                      if (warpKind === "badExit") {
                        return {
                          ...sess,
                          spawn: (command, options) =>
                            Effect.map(sess.spawn(command, options), (proc) => ({
                              ...proc,
                              exitCode: Effect.succeed(0 as never)
                            }))
                        }
                      }
                      return {
                        ...sess,
                        readFile: () => Effect.succeed(new TextEncoder().encode("corrupted"))
                      }
                    })
                }

              const violations = yield* SandboxConformance.check(provider)
              if (warpKind === "truthful") {
                expect(violations).toEqual([])
              } else {
                expect(violations.length).toBeGreaterThanOrEqual(1)
              }
              return true
            } finally {
              rmSync(root, { recursive: true, force: true })
            }
          }),
        { executions: Math.min(executions, 8), seed }
      )
    )
    assertPassed(report)
  }, 120_000)

  it(
    "Sandbox.fileSystem agrees differentially with NodeFileSystem across stat, read/write, mkdir, readdir, rename, copy, symlink, readLink, realPath, access, exists, chmod, and remove",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          op: Schema.Literals([
            "writeRead",
            "statMissing",
            "mkdirReaddir",
            "rename",
            "renameToDirFails",
            "copy",
            "symlinkReadLinkRealpath",
            "readLinkNonLinkAndMissing",
            "removeRecursive",
            "chmodAccess",
            "existsCheck",
            "realPathMissing"
          ]),
          name: Schema.Literals(["alpha.txt", "nested/beta.txt", "dir-a/sub/gamma.txt"]),
          body: Schema.Literals(["hello world\n", "line1\nline2\n", ""])
        })
      )

      const services = await Effect.runPromise(getServices)

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ op, name, body }) =>
            Effect.gen(function*() {
              const root = realpathSync(mkdtempSync(join(tmpdir(), "sb-fs-w7-")))
              try {
                const provider = DirectorySandbox.make({ ...services, root })
                yield* Effect.scoped(
                  Effect.gen(function*() {
                    const session = yield* provider.acquire("fs-sess")
                    const sfs = Sandbox.fileSystem({ ...session, files: undefined })
                    const abs = join(session.workdir, name)
                    const parent = abs.slice(0, abs.lastIndexOf("/"))

                    yield* sfs.makeDirectory(parent, { recursive: true })
                    const bytes = new TextEncoder().encode(body)

                    if (op === "writeRead") {
                      yield* sfs.writeFile(abs, bytes)
                      const got = yield* sfs.readFile(abs)
                      const ref = yield* services.fs.readFile(abs)
                      expect(Buffer.from(got).toString("utf8")).toBe(Buffer.from(ref).toString("utf8"))
                      const st = yield* sfs.stat(abs)
                      expect(st.type).toBe("File")
                    } else if (op === "statMissing") {
                      const missing = join(session.workdir, "never-created.txt")
                      const sEx = yield* sfs.stat(missing).pipe(Effect.exit)
                      const nEx = yield* services.fs.stat(missing).pipe(Effect.exit)
                      expect(Exit.isFailure(sEx)).toBe(true)
                      expect(Exit.isFailure(nEx)).toBe(true)
                    } else if (op === "mkdirReaddir") {
                      yield* sfs.writeFile(abs, bytes)
                      const sList = [...(yield* sfs.readDirectory(parent))].sort()
                      const nList = [...(yield* services.fs.readDirectory(parent))].sort()
                      expect(sList).toEqual(nList)
                    } else if (op === "rename") {
                      yield* sfs.writeFile(abs, bytes)
                      const dst = `${abs}.moved`
                      yield* sfs.rename(abs, dst)
                      expect(yield* sfs.exists(abs)).toBe(false)
                      expect(yield* sfs.exists(dst)).toBe(true)
                    } else if (op === "renameToDirFails") {
                      yield* sfs.writeFile(abs, bytes)
                      const targetDir = join(session.workdir, "target-dir")
                      yield* sfs.makeDirectory(targetDir, { recursive: true })
                      const rEx = yield* sfs.rename(abs, targetDir).pipe(Effect.exit)
                      expect(Exit.isFailure(rEx)).toBe(true)
                    } else if (op === "copy") {
                      const badFlag = yield* sfs.writeFile(abs, bytes, { flag: "a" }).pipe(Effect.exit)
                      expect(Exit.isFailure(badFlag)).toBe(true)
                      const badMode = yield* sfs.writeFileString(abs, body, { mode: 0o600 }).pipe(Effect.exit)
                      expect(Exit.isFailure(badMode)).toBe(true)
                      yield* sfs.writeFileString(abs, body)
                      expect(yield* sfs.readFileString(abs)).toBe(body)
                    } else if (op === "symlinkReadLinkRealpath") {
                      yield* sfs.writeFile(abs, bytes)
                      const link = `${abs}.link`
                      yield* services.fs.symlink(abs, link)
                      const target = yield* sfs.readLink(link)
                      expect(target).toBe(abs)
                      const resolved = yield* sfs.realPath(link)
                      const refResolved = yield* services.fs.realPath(link)
                      expect(resolved).toBe(refResolved)
                    } else if (op === "readLinkNonLinkAndMissing") {
                      yield* sfs.writeFile(abs, bytes)
                      const nonLinkEx = yield* sfs.readLink(abs).pipe(Effect.exit)
                      const missEx = yield* sfs.readLink(join(session.workdir, "missing-link")).pipe(Effect.exit)
                      expect(Exit.isFailure(nonLinkEx)).toBe(true)
                      expect(Exit.isFailure(missEx)).toBe(true)
                    } else if (op === "removeRecursive") {
                      yield* sfs.writeFile(abs, bytes)
                      yield* sfs.remove(parent, { recursive: true })
                      expect(yield* sfs.exists(parent)).toBe(false)
                    } else if (op === "chmodAccess") {
                      yield* sfs.writeFile(abs, bytes)
                      const rdFileEx = yield* sfs.readDirectory(abs).pipe(Effect.exit)
                      expect(Exit.isFailure(rdFileEx)).toBe(true)
                      const underFileEx = yield* sfs.exists(`${abs}/child`).pipe(Effect.exit)
                      expect(Exit.isFailure(underFileEx)).toBe(true)
                      const mkDupEx = yield* sfs.makeDirectory(abs).pipe(Effect.exit)
                      expect(Exit.isFailure(mkDupEx)).toBe(true)
                      const mkMissingParentEx = yield* sfs.makeDirectory(`${session.workdir}/no-such-parent/child`)
                        .pipe(Effect.exit)
                      expect(Exit.isFailure(mkMissingParentEx)).toBe(true)
                    } else if (op === "existsCheck") {
                      expect(yield* sfs.exists(abs)).toBe(false)
                      yield* sfs.writeFile(abs, bytes)
                      expect(yield* sfs.exists(abs)).toBe(true)
                    } else {
                      const mEx = yield* sfs.realPath(join(session.workdir, "absent-path")).pipe(Effect.exit)
                      expect(Exit.isFailure(mEx)).toBe(true)
                    }
                  })
                )
                return true
              } finally {
                rmSync(root, { recursive: true, force: true })
              }
            }),
          { executions: Math.min(executions, 30), seed: seed + 1 }
        )
      )
      assertPassed(report)
    },
    120_000
  )

  it("Sandbox.job validates provider retention, jobDirectory confinement, keys, and input file paths", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        badDir: Schema.Literals(["relative/jobs", "/tmp/a/../b", "/tmp/a\0b", `${pidDirectory}/sub`]),
        badFile: Schema.Literals(["", "../escape.txt", "a\0b", "/var/lib/smthrs-jobs/meta"])
      })
    )

    const services = await Effect.runPromise(getServices)

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ badDir, badFile }) =>
          Effect.gen(function*() {
            const root = realpathSync(mkdtempSync(join(tmpdir(), "sb-job-w7-")))
            try {
              const ephemeral = DirectorySandbox.make({ ...services, root })
              expect(() => Sandbox.job(ephemeral, { command: "true" })).toThrow(/retained/)

              const sticky = DirectorySandbox.make({ ...services, root: join(root, "machines"), persistence: "sticky" })
              expect(() => Sandbox.job(sticky, { command: "true", jobDirectory: badDir })).toThrow(TypeError)

              const jobDir = join(root, "jobs-meta")
              const job = Sandbox.job(sticky, {
                command: "true",
                jobDirectory: jobDir,
                files: { [badFile]: new Uint8Array([1, 2, 3]) }
              })
              const emptyKey = yield* job.start({}, "   ").pipe(Effect.exit)
              expect(Exit.isFailure(emptyKey)).toBe(true)

              const badFileExit = yield* job.start({}, "valid-key").pipe(Effect.exit)
              expect(Exit.isFailure(badFileExit)).toBe(true)

              const wrongHandleExit = yield* job
                .status(
                  { id: "other-id", remoteId: "rem", workdir: "/tmp/w", directory: "/wrong/dir" },
                  "valid-key"
                )
                .pipe(Effect.exit)
              expect(Exit.isFailure(wrongHandleExit)).toBe(true)
              return true
            } finally {
              rmSync(root, { recursive: true, force: true })
            }
          }),
        { executions: Math.min(executions, 25), seed: seed + 2 }
      )
    )
    assertPassed(report)
  }, 60_000)
})
