import { PlantedBugLabel } from "../../labels.platform.ts";
export { BUG_CLASSES } from "../../labels.platform.ts";
export { SeededBugSeverity } from "../../labels.platform.ts";
export { SeededBugCategory } from "../../labels.platform.ts";
export { BugClass } from "../../labels.platform.ts";
export { SeededBugLabel } from "../../labels.platform.ts";
export { CleanControlLabel } from "../../labels.platform.ts";
export { PlantedBugLabel } from "../../labels.platform.ts";
/**
 * Reads every fixture's label, in directory order.
 *
 * The fixture field must equal the directory name: a label that names a
 * different fixture would score one fixture's findings against another's
 * ground truth, which is worse than not scoring at all.
 *
 * @since 1.0.0
 * @category constructors
 */
export declare function loadCorpus(corpusDir?: string): PlantedBugLabel[];
