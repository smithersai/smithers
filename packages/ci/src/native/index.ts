/**
 * A repository that already builds with Smithers build.
 *
 * @since 0.1.0
 */

export { replaced, workspace } from "./Detect.vibe"
export {
  commandFailed,
  installDirectories,
  type Installed,
  installLabel,
  type Manager,
  managerFor,
  managers,
  noSmthrs,
  smthrsBin
} from "./Install.ts"
export { committedWorkspace, type Host, install, own, run } from "./Replay.vibe"
export { firstLine, linesOf, nothingPassed, reasonsIn, withReasons } from "./Results.ts"
export { type Chosen, chosenFor, covers, everything, notSelected, notTargets, patternsIn } from "./Targets.ts"
export { footer, found, generatedMark, isBuildFile, isGenerated, overwriteRefusal, refusal } from "./Workspace.ts"
