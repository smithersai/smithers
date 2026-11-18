/**
 * A repository that already builds with Smithers build.
 *
 * @since 0.1.0
 */

export { firstLine, nothingPassed } from "../replay/Failures.ts"
export { workspace } from "./Detect.vibe"
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
export {
  linesOf,
  noRecord,
  noRecordLabel,
  ranAgain,
  ranAgainLines,
  reasonsIn,
  whyNoRecord,
  withReasons
} from "./Results.ts"
export { type Chosen, chosenFor, covers, everything, notSelected, notTargets, patternsIn } from "./Targets.ts"
export { footer, found, generatedMark, isGenerated, overwriteRefusal, refusal } from "./Workspace.ts"
