/** Owner-private native publication, shared by host consumers. @since 1.0.0 */
import type * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import { Effect, type PlatformError } from "effect"
import { realpath, stat } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"

/** @since 1.0.0 @category models */
export interface Service {
  readonly append: (file: string, text: string) => Effect.Effect<void, PlatformError.PlatformError>
}

/** @internal */
export const make = (
  execute: (request: KernelFileSystem.AtomicRequest) => Effect.Effect<unknown, PlatformError.PlatformError>,
  failure: (path: string, cause: unknown) => PlatformError.PlatformError
): Service => ({
  append: (file, text) =>
    Effect.gen(function*() {
      const target = resolve(file)
      // Canonicalize only the trusted parent. The native owner opens the leaf
      // without following aliases and verifies its ACL/mode before any write.
      const { root, identity } = yield* Effect.tryPromise({
        try: async () => {
          const root = await realpath(dirname(target))
          const info = await stat(root, { bigint: true })
          return { root, identity: `${info.dev}:${info.ino}` }
        },
        catch: (cause) => failure(file, cause)
      })
      // This native-only open flag is rejected by older helpers; it can never
      // silently degrade to an ordinary append with permission bits on Windows.
      yield* execute({
        operation: "writeFileString",
        boundaryRoot: root,
        logicalRoot: root,
        rootIdentity: identity,
        path: join(root, basename(target)),
        data: text,
        options: { flag: "a-private", mode: 0o600 }
      } as unknown as KernelFileSystem.AtomicRequest)
    })
})
