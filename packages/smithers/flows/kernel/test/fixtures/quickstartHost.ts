import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Effect, FileSystem as EffectFileSystem, Layer } from "effect"
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as FileSystem from "../../src/FileSystem.ts"
import * as Workspace from "../../src/Workspace.ts"

/**
 * A throwaway workspace holding `README.md` with `# hello`.
 *
 * @throws When the temporary directory cannot be created or written.
 */
export const makeWorkspace = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "flows-kernel-quickstart-")))
  writeFileSync(join(root, "README.md"), "# hello")
  return root
}

/**
 * The raw host the VibeLang quickstart guards: the real Node filesystem
 * attested as an isolated volume, Node's `Path`, and the workspace root. The
 * kernel cannot depend on `@smthrs/testing`, whose `TestHost` the page uses,
 * because that package depends on the kernel.
 *
 * @throws {never}
 */
export const rawHost = (root: string) =>
  Layer.mergeAll(
    Layer.effect(
      EffectFileSystem.FileSystem,
      Effect.map(EffectFileSystem.FileSystem, FileSystem.withIsolatedFileSystem)
    ).pipe(Layer.provide(NodeFileSystem.layer)),
    NodePath.layer,
    Workspace.layer(root)
  )
