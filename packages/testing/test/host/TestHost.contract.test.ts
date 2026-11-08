import { runHostContract } from "@smthrs/kernel/test/contract"
import { Deferred, Effect, FileSystem, Layer, Stream } from "effect"
import * as ChildProcess from "effect/process/ChildProcess"
import { expect } from "vitest"
import * as TestHost from "../../src/TestHost.vibe"

const host = TestHost.layer({
  files: {},
  commands: {
    "host-contract-exec": { stdout: "test-exec" },
    "host-contract-stream": { stdout: "test-stream" },
    "host-contract-options": { stdout: "test-options" },
    "host-contract-interrupt": { pending: true }
  }
})

const caps = {
  fileSystem: {
    expected: "success",
    scratchPath: "/test-host-contract",
    unsupported: {
      chmod: "PermissionDenied",
      chown: "PermissionDenied",
      copy: "PermissionDenied",
      copyFile: "PermissionDenied",
      glob: "PermissionDenied",
      link: "PermissionDenied",
      makeTempDirectory: "PermissionDenied",
      makeTempDirectoryScoped: "PermissionDenied",
      makeTempFile: "PermissionDenied",
      makeTempFileScoped: "PermissionDenied",
      open: "PermissionDenied",
      readLink: "PermissionDenied",
      rename: "PermissionDenied",
      sink: "PermissionDenied",
      symlink: "PermissionDenied",
      truncate: "PermissionDenied",
      utimes: "PermissionDenied",
      watch: "PermissionDenied"
    }
  },
  path: { expected: "success" },
  childProcess: {
    expected: "success",
    execCommand: ChildProcess.make("host-contract-exec"),
    expectedStdout: "test-exec",
    streamCommand: ChildProcess.make("host-contract-stream"),
    expectedStreamText: "test-stream",
    optionsCommand: ChildProcess.make("host-contract-options", [], {
      cwd: "/",
      env: { HOST_CONTRACT_ENV: "test" }
    }),
    expectedOptionsStdout: "test-options",
    // The scripted interpreter runs a command line to completion; it has no
    // stdin to feed.
    stdin: { expected: "failure", code: "BadArgument" },
    pipeline: { expected: "failure", code: "BadArgument" },
    interruptCommand: ChildProcess.make("host-contract-interrupt")
  },
  jj: { expected: "failure", code: "not_installed" },
  httpClient: { expected: "failure", code: "TransportError" }
} as const

runHostContract("TestHost", host, caps)

// Deterministically lose the first sentinel write: subscription starts only
// after that write. A single write after any fixed delay cannot pass this host.
const delayedWatch = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const firstWrite = yield* Deferred.make<void>()
    const event = yield* Deferred.make<FileSystem.WatchEvent>()
    let subscribed = false
    let writes = 0
    return FileSystem.makeNoop({
      ...fs,
      watch: () =>
        Stream.fromEffect(Effect.gen(function*() {
          yield* Deferred.await(firstWrite)
          subscribed = true
          return yield* Deferred.await(event)
        })),
      writeFile: (path, bytes, options) =>
        fs.writeFile(path, bytes, options).pipe(
          Effect.andThen(Effect.gen(function*() {
            if (!path.endsWith("/watch-watched.txt")) return
            writes++
            if (subscribed) {
              expect(writes).toBeGreaterThan(1)
              yield* Deferred.succeed(event, { _tag: "Update" as const, path })
            } else {
              yield* Deferred.succeed(firstWrite, undefined)
            }
          }))
        )
    })
  })
).pipe(Layer.provideMerge(host))

const { watch: _watch, ...unsupported } = caps.fileSystem.unsupported
runHostContract("TestHost with delayed watch subscription", delayedWatch, {
  ...caps,
  fileSystem: { ...caps.fileSystem, unsupported }
})
