import { NodeServices } from "@effect/platform-node"
import * as Path from "@smthrs/kernel/Path"
import { Cause, Effect, Exit, PlatformError } from "effect"
import * as FileSystem from "effect/FileSystem"
import { describe, expect, it } from "vitest"
import * as Walk from "../src/internal/Walk.ts"
import type * as StdError from "../src/StdError.ts"

const walk = (fileSystem: FileSystem.FileSystem, root: string) =>
  Effect.runPromise(
    Effect.exit(
      Effect.gen(function*() {
        const path = yield* Path.Path
        return yield* Walk.files(fileSystem, path, root, false)
      }).pipe(Effect.provide(NodeServices.layer))
    )
  )

const failure = (exit: Exit.Exit<Walk.Walked, StdError.StdError>): StdError.StdError | undefined => {
  if (!Exit.isFailure(exit)) return undefined
  const reason = exit.cause.reasons[0]
  return reason !== undefined && Cause.isFailReason(reason) ? reason.error : undefined
}

const statFailing = (tag: PlatformError.SystemErrorTag, description: string) =>
  FileSystem.makeNoop({
    stat: (path) =>
      Effect.fail(PlatformError.systemError({
        _tag: tag,
        module: "FileSystem",
        method: "stat",
        pathOrDescriptor: path,
        description
      }))
  })

describe("Walk.files", () => {
  it("reports a denied root as its own failure, naming the cause, not as a missing path", async () => {
    const cause = "ENOENT: no such file or directory, lstat '/usr/local/bin/smithers-jj-export'"
    const error = failure(await walk(statFailing("PermissionDenied", cause), "."))
    expect(error).toBeDefined()
    expect(error?.code).not.toBe("not_found")
    expect(error?.message).not.toContain("Path not found")
    expect(error?.message).toContain("PermissionDenied")
    expect(error?.message).toContain(cause)
    expect(error?.path).toBe(".")
  })

  it("reports a genuinely missing root as not_found", async () => {
    const error = failure(await walk(statFailing("NotFound", "ENOENT"), "/missing"))
    expect(error?.code).toBe("not_found")
    expect(error?.message).toBe("Path not found: /missing")
  })
})
