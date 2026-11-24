import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, FileSystem, Schema, Sink, Stream } from "effect"
import * as ChildProcess from "effect/process/ChildProcess"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import { describe, expect, it } from "vitest"
import * as Refusals from "../src/internal/Refusals.ts"

const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261152")
const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "100")
const fastExec = Math.max(40, Math.min(baseExecutions, 120))

const assertPassed = <A>(report: Fuzz.Report<A>): void => {
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

describe("@smthrs/platform-cloudflare Wave 9 deep fuzzing", () => {
  it(
    "Refusals.layerFileSystem and Refusals.layerChildProcessSpawner fail closed on every single filesystem and process method",
    async () => {
      const fsOps = [
        "access",
        "chmod",
        "chown",
        "copy",
        "copyFile",
        "exists",
        "glob",
        "link",
        "makeDirectory",
        "makeTempDirectory",
        "makeTempDirectoryScoped",
        "makeTempFile",
        "makeTempFileScoped",
        "open",
        "readDirectory",
        "readFile",
        "readFileString",
        "readLink",
        "realPath",
        "remove",
        "rename",
        "sink",
        "stat",
        "stream",
        "symlink",
        "truncate",
        "utimes",
        "watch",
        "writeFile",
        "writeFileString"
      ] as const

      const arb = Arbitrary.schema(
        Schema.Struct({
          op: Schema.Literals(fsOps),
          path: Schema.Literals(["/etc/passwd", "./foo", "nested/dir/file.txt", ""]),
          cmd: Schema.Literals(["sh", "git", "node", "rm"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ op, path, cmd }) =>
            Effect.gen(function*() {
              const fs = yield* FileSystem.FileSystem
              const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

              const invokeFs = (): Effect.Effect<unknown, unknown> => {
                switch (op) {
                  case "access":
                    return fs.access(path)
                  case "chmod":
                    return fs.chmod(path, 0o644)
                  case "chown":
                    return fs.chown(path, 0, 0)
                  case "copy":
                    return fs.copy(path, `${path}.bak`)
                  case "copyFile":
                    return fs.copyFile(path, `${path}.bak`)
                  case "exists":
                    return fs.exists(path)
                  case "glob":
                    return fs.glob(path)
                  case "link":
                    return fs.link(path, `${path}.lnk`)
                  case "makeDirectory":
                    return fs.makeDirectory(path)
                  case "makeTempDirectory":
                    return fs.makeTempDirectory()
                  case "makeTempDirectoryScoped":
                    return Effect.scoped(fs.makeTempDirectoryScoped())
                  case "makeTempFile":
                    return fs.makeTempFile()
                  case "makeTempFileScoped":
                    return Effect.scoped(fs.makeTempFileScoped())
                  case "open":
                    return Effect.scoped(fs.open(path))
                  case "readDirectory":
                    return fs.readDirectory(path)
                  case "readFile":
                    return fs.readFile(path)
                  case "readFileString":
                    return fs.readFileString(path)
                  case "readLink":
                    return fs.readLink(path)
                  case "realPath":
                    return fs.realPath(path)
                  case "remove":
                    return fs.remove(path)
                  case "rename":
                    return fs.rename(path, `${path}.new`)
                  case "sink":
                    return Stream.run(Stream.make(new Uint8Array([1, 2])), fs.sink(path))
                  case "stat":
                    return fs.stat(path)
                  case "stream":
                    return Stream.runCollect(fs.stream(path))
                  case "symlink":
                    return fs.symlink(path, `${path}.sym`)
                  case "truncate":
                    return fs.truncate(path)
                  case "utimes":
                    return fs.utimes(path, new Date(0), new Date(0))
                  case "watch":
                    return Stream.runCollect(fs.watch(path))
                  case "writeFile":
                    return fs.writeFile(path, new Uint8Array([1]))
                  case "writeFileString":
                    return fs.writeFileString(path, "data")
                }
              }

              const fsExit = yield* Effect.exit(invokeFs())
              expect(Exit.isFailure(fsExit)).toBe(true)
              if (Exit.isFailure(fsExit)) {
                const str = String(fsExit.cause)
                expect(str).toContain("PermissionDenied")
              }

              const spawnExit = yield* Effect.exit(
                Effect.scoped(spawner.spawn(ChildProcess.make(cmd, ["-v"])))
              )
              expect(Exit.isFailure(spawnExit)).toBe(true)
              if (Exit.isFailure(spawnExit)) {
                expect(String(spawnExit.cause)).toContain("NotFound")
              }
              return true
            }).pipe(
              Effect.provide(Refusals.layerFileSystem),
              Effect.provide(Refusals.layerChildProcessSpawner)
            ),
          { seed, executions: fastExec }
        )
      )
      assertPassed(report)
    },
    60_000
  )
})
