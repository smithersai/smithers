import { fileURLToPath as $fileURLToPath } from "node:url"
import { dirname as $dirname } from "node:path"
export function $importMetaDirname(url: string): ImportMeta["dirname"] { return (url.startsWith("file:") ? $dirname($fileURLToPath(url)) : undefined) as ImportMeta["dirname"] }

// The platform code of labels.vibe, which a .vibe file does not import as a value (EK4402).

/**
 * The seeded-bug corpus and its labels.
 *
 * Each fixture is a `base/` tree, a `head/` tree, and a `label.json` naming
 * either one planted defect or a clean control. The label is the ground truth
 * the scorer matches review findings against, so it is validated strictly:
 * a fixture whose label does not parse is a broken corpus, not a low score.
 *
 * @since 1.0.0
 */
import { Schema } from "effect";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The defect classes the corpus plants.
 *
 * @since 1.0.0
 * @category constants
 */
export const BUG_CLASSES = [
  "missing-await",
  "off-by-one-boundary",
  "sql-injection",
  "resource-leak",
  "deleted-null-check",
  "tautological-test",
  "cross-file-signature-mismatch",
] as const;
/**
 * A finding's severity, in the review's own vocabulary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const SeededBugSeverity = Schema.Literals(["critical", "major", "minor", "info"]);
/**
 * The decoded severity.
 *
 * @since 1.0.0
 * @category models
 */
export type SeededBugSeverity = typeof SeededBugSeverity.Type;
/**
 * A finding's category, in the review's own vocabulary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const SeededBugCategory = Schema.Literals([
  "correctness",
  "security",
  "performance",
  "data-loss",
  "tests",
  "docs",
  "style",
  "other",
]);
/**
 * The decoded category.
 *
 * @since 1.0.0
 * @category models
 */
export type SeededBugCategory = typeof SeededBugCategory.Type;
/**
 * One of {@link BUG_CLASSES}.
 *
 * @since 1.0.0
 * @category schemas
 */
export const BugClass = Schema.Literals(BUG_CLASSES);
/**
 * The decoded bug class.
 *
 * @since 1.0.0
 * @category models
 */
export type BugClass = typeof BugClass.Type;
/**
 * A fixture that plants one defect.
 *
 * @since 1.0.0
 * @category schemas
 */
export const SeededBugLabel = Schema.Struct({
  fixture: Schema.String,
  clean: Schema.Literal(false),
  bugClass: BugClass,
  category: SeededBugCategory,
  severity: SeededBugSeverity,
  file: Schema.String,
  line: Schema.Number,
  description: Schema.String,
});
/**
 * The decoded planted-bug label.
 *
 * @since 1.0.0
 * @category models
 */
export type SeededBugLabel = typeof SeededBugLabel.Type;
/**
 * A fixture that plants nothing: any finding on it is a false positive.
 *
 * @since 1.0.0
 * @category schemas
 */
export const CleanControlLabel = Schema.Struct({
  fixture: Schema.String,
  clean: Schema.Literal(true),
  description: Schema.String,
});
/**
 * The decoded clean-control label.
 *
 * @since 1.0.0
 * @category models
 */
export type CleanControlLabel = typeof CleanControlLabel.Type;
/**
 * Either kind of label.
 *
 * @since 1.0.0
 * @category schemas
 */
export const PlantedBugLabel = Schema.Union([SeededBugLabel, CleanControlLabel]);
/**
 * The decoded label.
 *
 * @since 1.0.0
 * @category models
 */
export type PlantedBugLabel = typeof PlantedBugLabel.Type;
const decodeLabel = Schema.decodeUnknownSync(PlantedBugLabel);
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
export function loadCorpus(corpusDir = join($importMetaDirname(import.meta.url), "corpus")): PlantedBugLabel[] {
  return readdirSync(corpusDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
    .map((fixture) => {
      const labelPath = join(corpusDir, fixture, "label.json");
      const parsed = decodeLabel(JSON.parse(readFileSync(labelPath, "utf8")));
      if (parsed.fixture !== fixture) {
        throw new Error(`${labelPath} fixture field must equal directory name "${fixture}"`);
      }
      return parsed;
    });
}
