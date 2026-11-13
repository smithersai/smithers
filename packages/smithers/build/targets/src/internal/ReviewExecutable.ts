/**
 * Content identity for a review command using existing host capabilities.
 * @since 1.0.0
 */

import type { createHash } from "node:crypto"
import type * as NodeFs from "node:fs"
import type * as NodePath from "node:path"

/**
 * Host operations retained at the existing process boundary.
 * @since 1.0.0
 * @private
 */
export interface Host {
  readonly path: string | undefined
  readonly platform: NodeJS.Platform
  readonly execPath: string
  readonly paths: Pick<typeof NodePath, "isAbsolute" | "resolve" | "join" | "delimiter">
  readonly nativeStat: typeof NodeFs.statSync
  readonly createHash: typeof createHash
}

/**
 * Whether a real absolute entry is a Node module on the selected host.
 * @category identity
 * @since 1.0.0
 */
export const nodeModule = (path: string, options: {
  readonly platform: NodeJS.Platform
  readonly stat: typeof NodeFs.statSync
  readonly isAbsolute: (path: string) => boolean
}): boolean =>
  options.platform === "win32" && options.isAbsolute(path) && /\.(?:mjs|cjs|js)$/.test(path) &&
  options.stat(path, { throwIfNoEntry: false })?.isFile() === true

/**
 * Resolves and hashes the entrypoint; Windows scripts also bind interpreter bytes.
 * @category identity
 * @since 1.0.0
 */
export const identity = async (
  executable: string,
  io: typeof NodeFs,
  host: Host
): Promise<{ readonly executable?: { readonly path: string; readonly sha256: string } }> => {
  const path = (host.paths.isAbsolute(executable) || executable.includes("/") ?
    [host.paths.resolve(executable)] :
    (host.path ?? "")
      .split(host.paths.delimiter).filter(Boolean).map((directory) => host.paths.join(directory, executable)))
    .find((candidate) => io.statSync(candidate, { throwIfNoEntry: false })?.isFile() === true)
  if (path === undefined) return {}
  const hash = host.createHash("sha256")
  for await (const chunk of io.createReadStream(path)) hash.update(chunk as Buffer)
  const identity = { path: io.realpathSync(path), sha256: hash.digest("hex") }
  if (!nodeModule(path, { platform: host.platform, stat: host.nativeStat, isAbsolute: host.paths.isAbsolute })) {
    return { executable: identity }
  }
  const interpreter = host.createHash("sha256")
  for await (const chunk of io.createReadStream(host.execPath)) interpreter.update(chunk as Buffer)
  return {
    executable: {
      path: identity.path,
      sha256: host.createHash("sha256").update(JSON.stringify([identity.sha256, interpreter.digest("hex")])).digest(
        "hex"
      )
    }
  }
}
