/**
 * Source identity shared with packages whose tests execute the engine.
 *
 * Kept separate from PACKAGE.ts because the engine library depends on flow,
 * while flow's test and check targets also need the engine's source identity.
 *
 * @since 0.1.0
 */
import { Smithers } from "@smthrs/targets"
import { Package as journalPackage } from "../journal/PACKAGE.ts"

/**
 * Engine sources and their journal dependency, without the library's
 * dependency on the flow targets.
 *
 * @category inputs
 * @since 0.1.0
 */
export const engineSourceInputs = Smithers.Filegroup({
  srcs: [Smithers.glob("src/**/*.{ts,vibe}"), journalPackage.lib],
  cwd: "packages/smithers/flows/engine"
})
