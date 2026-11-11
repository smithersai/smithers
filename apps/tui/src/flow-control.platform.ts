/**
 * The platform code of flow-control.vibe: the runtime's control composition
 * and the state files' presence, which a .vibe file does not read from Node.
 */
import * as BunControl from "@smthrs/cli/BunControl"
import * as NodeControl from "@smthrs/cli/NodeControl"
import { existsSync } from "node:fs"
import { join } from "node:path"

/** Whether this process runs on Bun; the control composition and the model transport follow it. */
export const isBun = process.versions.bun !== undefined

/** The control composition for this runtime: Bun's under Bun, Node's otherwise. */
export const NativeControl = isBun ? BunControl : NodeControl

/**
 * Whether `directory` exists under `cwd`.
 * @throws {never}
 */
export function hasDirectory(cwd: string, directory: string): boolean {
  return existsSync(join(cwd, directory))
}

/**
 * Whether `root` already holds a workspace control database; a read never creates one.
 * @throws {never}
 */
export function hasControlDatabase(root: string): boolean {
  return existsSync(join(root, ".flows", "control.db"))
}
