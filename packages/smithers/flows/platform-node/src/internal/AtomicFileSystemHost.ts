/**
 * The native Node calls the atomic filesystem makes beside its helper:
 * canonical path spelling, exact root identity, and watching. Each takes the
 * host primitives it reads as a parameter, so a test supplies a faulty one.
 * @since 1.0.0
 */

import { Effect, type FileSystem, type PlatformError, Stream } from "effect"
import type { BigIntStats } from "node:fs"
import { realpath, stat } from "node:fs/promises"
import * as Protocol from "./AtomicFileSystemProtocol.ts"

/**
 * The platform and filesystem calls the host layer reads.
 * @private
 * @since 1.0.0
 */
export interface NativeHost {
  readonly platform: NodeJS.Platform
  readonly realpath: (path: string) => Promise<string>
  readonly stat: (path: string) => Promise<BigIntStats>
}

/**
 * This process's platform and Node's own calls.
 * @private
 * @since 1.0.0
 */
export const nodeHost: NativeHost = {
  platform: process.platform,
  realpath: (path) => realpath(path),
  stat: (path) => stat(path, { bigint: true })
}

/** The rejection Node reported, kept with its errno for the typed reason. */
const rejected = (operation: "realPath" | "stat", path: string, cause: unknown): PlatformError.PlatformError =>
  Protocol.failure({ operation, path }, cause, {
    ok: false,
    code: (cause as NodeJS.ErrnoException).code ?? null,
    message: (cause as NodeJS.ErrnoException).message,
    syscall: operation === "realPath" ? "realpath" : "stat"
  })

/**
 * The native canonical spelling of `path`, which expands Windows DOS names.
 * @private
 * @since 1.0.0
 */
export const realPath = (host: NativeHost) => (path: string): Effect.Effect<string, PlatformError.PlatformError> =>
  Effect.tryPromise({ try: () => host.realpath(path), catch: (cause) => rejected("realPath", path, cause) })

/**
 * The root's exact `dev:ino` identity, from BigInt stats so no inode loses precision.
 * @private
 * @since 1.0.0
 */
export const identifyRoot = (host: NativeHost) => (path: string): Effect.Effect<string, PlatformError.PlatformError> =>
  Effect.tryPromise({
    try: async () => {
      const info = await host.stat(path)
      return `${info.dev}:${info.ino}`
    },
    catch: (cause) => rejected("stat", path, cause)
  })

/**
 * Watches `path`; Windows watches its canonical spelling, so events report
 * paths relative to the directory the caller named.
 * @private
 * @since 1.0.0
 */
export const watch = (host: NativeHost, fileSystem: FileSystem.FileSystem): FileSystem.FileSystem["watch"] =>
(
  path,
  options
) =>
  host.platform !== "win32"
    ? fileSystem.watch(path, options)
    : Stream.unwrap(realPath(host)(path).pipe(Effect.map((canonical) => fileSystem.watch(canonical, options))))
