import * as NodeServices from "@effect/platform-node/NodeServices"
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import type * as Path from "@smthrs/kernel/Path"
import { Effect, Sink, Stream } from "effect"
import type * as FileSystem from "effect/FileSystem"
import { ExitCode, makeHandle, ProcessId } from "effect/process/ChildProcessSpawner"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as NativeSearch from "../src/NativeSearch.vibe"
import * as Search from "../src/Search.vibe"

describe.skipIf(process.platform === "win32")("NativeSearch environment", () => {
  for (const declared of [false, true]) {
    it(`filters the real rg child's ambient sentinel with declared=${declared}`, async () => {
      const directory = mkdtempSync(join(tmpdir(), "std-native-env-"))
      const previousPath = process.env["PATH"]
      const previousSecret = process.env["SMITHERS_RG_DUMMY_SECRET"]
      // A sentinel executable at the real rg spawn boundary emits only a dummy value.
      writeFileSync(join(directory, "rg"), "#!/bin/sh\nprintf '%s\\0' \"${SMITHERS_RG_DUMMY_SECRET:-absent}\"\n")
      chmodSync(join(directory, "rg"), 0o755)
      process.env["PATH"] = `${directory}:${previousPath ?? ""}`
      process.env["SMITHERS_RG_DUMMY_SECRET"] = "ambient-dummy"
      try {
        const result = await Effect.runPromise(
          Effect.gen(function*() {
            const search = declared
              ? NativeSearch.make(
                yield* Effect.context<FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner>(),
                { SMITHERS_RG_DUMMY_SECRET: "declared-dummy" }
              )
              : yield* Effect.provide(Search.Search, NativeSearch.layer)
            return yield* search.glob({ root: directory, pattern: "*", hidden: false, limit: 10 })
          }).pipe(Effect.provide(NodeServices.layer))
        )
        expect(result.paths).toEqual([join(directory, declared ? "declared-dummy" : "absent")])
      } finally {
        if (previousPath === undefined) delete process.env["PATH"]
        else process.env["PATH"] = previousPath
        if (previousSecret === undefined) delete process.env["SMITHERS_RG_DUMMY_SECRET"]
        else process.env["SMITHERS_RG_DUMMY_SECRET"] = previousSecret
        rmSync(directory, { recursive: true, force: true })
      }
    })
  }
})

describe("NativeSearch capture", () => {
  for (const stream of ["stdout", "stderr"] as const) {
    it(`refuses ${stream} past the native capture cap`, async () => {
      const spawner = ChildProcessSpawner.makeNoop({
        spawn: () =>
          Effect.succeed(makeHandle({
            pid: ProcessId(1),
            exitCode: Effect.succeed(ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            stdin: Sink.drain,
            stdout: stream === "stdout"
              ? Stream.make(new Uint8Array(NativeSearch.MAX_CAPTURE_BYTES + 1))
              : Stream.empty,
            stderr: stream === "stderr"
              ? Stream.make(new Uint8Array(NativeSearch.MAX_CAPTURE_BYTES + 1))
              : Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void)
          }))
      })
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const search = yield* Effect.provide(Search.Search, NativeSearch.layer)
          return yield* Effect.flip(search.glob({ root: process.cwd(), pattern: "*", hidden: false, limit: 10 }))
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provide(NodeServices.layer)
        )
      )
      expect(result.code).toBe("command_failed")
      expect(result.message).toContain(`${stream} exceeded the ${NativeSearch.MAX_CAPTURE_BYTES}-byte capture cap`)
    })
  }
})
