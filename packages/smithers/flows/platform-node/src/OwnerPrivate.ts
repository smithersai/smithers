/**
 * Owner-private native publication, shared by host consumers.
 *
 * @since 1.0.0
 */

import { Effect, type PlatformError } from "effect"
import { realpath, stat } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { HostRequest } from "./internal/AtomicFileSystemProtocol.ts"

/**
 * Native operations that publish and append with owner-only access.
 *
 * @since 1.0.0
 * @category models
 */
export interface Service {
  readonly directory: (root: string, directory: string) => Effect.Effect<string, PlatformError.PlatformError>
  readonly write: (root: string, file: string, bytes: Uint8Array) => Effect.Effect<void, PlatformError.PlatformError>
  readonly syncDirectory: (directory: string, identity: string) => Effect.Effect<void, PlatformError.PlatformError>
  readonly append: (file: string, text: string) => Effect.Effect<void, PlatformError.PlatformError>
}

/**
 * Constructs owner-private publication against the host executor.
 *
 * @since 1.0.0
 * @private
 */
export const make = (
  execute: (request: HostRequest) => Effect.Effect<unknown, PlatformError.PlatformError>,
  failure: (path: string, cause: unknown) => PlatformError.PlatformError
): Service => {
  const pin = (base: string, target: string) =>
    Effect.tryPromise({
      try: async () => {
        const suffix = relative(resolve(base), resolve(target))
        if (suffix === "" || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
          throw new Error("private publication must be below its trusted root")
        }
        const root = await realpath(base)
        const info = await stat(root, { bigint: true })
        return {
          boundaryRoot: root,
          logicalRoot: root,
          rootIdentity: `${info.dev}:${info.ino}`,
          path: join(root, suffix)
        }
      },
      catch: (cause) => failure(target, cause)
    })
  return {
    directory: (base, target) =>
      Effect.gen(function*() {
        const pinned = yield* pin(base, target)
        yield* execute({ ...pinned, operation: "makePrivateDirectory" })
        return pinned.path
      }),
    write: (base, target, bytes) =>
      Effect.gen(function*() {
        const pinned = yield* pin(base, target)
        yield* execute({ ...pinned, operation: "writePrivateFile", data: Buffer.from(bytes).toString("base64") })
      }),
    syncDirectory: (root, identity) =>
      execute({
        operation: "syncDirectory",
        boundaryRoot: root,
        logicalRoot: root,
        rootIdentity: identity,
        path: root
      }).pipe(Effect.asVoid),
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
        } as unknown as HostRequest)
      })
  }
}
