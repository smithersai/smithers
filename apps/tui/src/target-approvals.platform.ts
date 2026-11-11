/**
 * The platform code of target-approvals.vibe: the runtime's control
 * composition and the control database's presence, which a .vibe file does
 * not read from Node directly.
 */
import * as BunControl from "@smthrs/cli/BunControl"
import * as NodeControl from "@smthrs/cli/NodeControl"
import { existsSync } from "node:fs"
import { join } from "node:path"

/** The control composition for this runtime: Bun's under Bun, Node's otherwise. */
export const NativeControl = process.versions.bun === undefined ? NodeControl : BunControl

/**
 * Whether `root` already holds a workspace control database; a read never creates one.
 * @throws {never}
 */
export function hasControlDatabase(root: string): boolean {
  return existsSync(join(root, ".flows", "control.db"))
}
