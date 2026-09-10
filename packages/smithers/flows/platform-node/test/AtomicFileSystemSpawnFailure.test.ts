/**
 * `spawn` can throw before it returns a child (for example when Node rejects a
 * malformed launch configuration). That arrival must fail the request through
 * the same closed boundary as an asynchronous child `error` event.
 */
import { describe, expect, it, vi } from "vitest"

vi.mock("node:child_process", async (importOriginal) => {
  const childProcess = await importOriginal<typeof import("node:child_process")>()
  return {
    ...childProcess,
    spawn: () => {
      throw new Error("synchronous spawn failure")
    }
  }
})

import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import { Effect, FileSystem, Layer } from "effect"
import * as AtomicFileSystem from "../src/AtomicFileSystem.ts"

const runDirect = <R extends KernelFileSystem.AtomicRequest>(request: R) =>
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const atomic = (fileSystem as KernelFileSystem.AtomicHostFileSystem)[KernelFileSystem.AtomicFileSystemTypeId]
    return yield* atomic.execute(request)
  }).pipe(Effect.provide(AtomicFileSystem.layer))

describe("atomic helper synchronous spawn failures", () => {
  it("fails closed when Node throws before creating the helper child", async () => {
    const failure = await Effect.runPromise(Effect.flip(runDirect({ operation: "exists", path: "/workspace/a" })))
    expect(failure).toMatchObject({ reason: { _tag: "PermissionDenied" } })
    expect(String((failure.reason as { readonly description?: string }).description)).toContain(
      "synchronous spawn failure"
    )
  })
})
