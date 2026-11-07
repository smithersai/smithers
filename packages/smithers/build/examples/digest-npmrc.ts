/**
 * Keys an install on a project's `.npmrc` without letting a credential into
 * the key. `PackageManager.npmrcDigest` hashes the file when every credential
 * is a registry-scoped environment placeholder, and refuses a literal token
 * with `unsafe_configuration`. `test/Examples.test.ts` runs it.
 */
import { NodeCrypto as NativeCrypto, NodeServices } from "@effect/platform-node"
import * as PackageManager from "@smthrs/build/PackageManager"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"

/**
 * Writes `npmrc` as the `.npmrc` of a fresh temporary project and resolves
 * with its digest, or with the refusal's code.
 */
export const digestNpmrc = async (npmrc: string) => {
  const projectRoot = await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-build-npmrc-"))
  try {
    await Fs.writeFile(Path.join(projectRoot, ".npmrc"), npmrc, "utf8")
    return await Effect.runPromise(
      PackageManager.npmrcDigest(projectRoot).pipe(
        Effect.catchTag("smithers-build/PackageManagerError", (error) => Effect.succeed(error.code)),
        Effect.provide(Layer.mergeAll(NodeServices.layer, NativeCrypto.layer))
      )
    )
  } finally {
    await Fs.rm(projectRoot, { recursive: true, force: true })
  }
}
