/**
 * The committed baseline of an offline seeded-bug run, and the drift report
 * that gates a re-run against it.
 *
 * The baseline is what `run.ts` writes with `--update` and reads on every
 * other run. It exists so a pipeline change that moves a score is loud: a red
 * gate means diff ingestion, fan-out, scoping, anchoring, de-duplication, or
 * the scorer moved, not that a model had a bad day.
 *
 * @since 1.0.0
 */
import type { PlantedBugLabel, SeededBugLabel, SeededBugSeverity } from "./labels.vibe";
import type { CorpusScore, MatchedFinding } from "./score.ts";

/** One fixture's run, reduced to the fields the baseline records. */
export interface FixtureOutcome {
  fixture: string;
  status: string;
}

/**
 * One planted bug's recorded outcome.
 *
 * The counts alone cannot see a finding that slid within the match tolerance
 * or one that kept its line and dropped from critical to info, so the anchor
 * records where the run put the finding and how it graded it.
 *
 * @since 1.0.0
 * @category models
 */
export interface BaselineAnchor {
  /** The file the planted bug lives in. */
  path: string;
  /** The line the planted bug lives on. */
  line: number;
  /** The line the matched finding anchored to, or `null` when it was missed. */
  anchoredLine: number | null;
  /** The severity the matched finding assigned, or `null` when it was missed. */
  severity: SeededBugSeverity | null;
  /** The severity the label expects. */
  expectedSeverity: SeededBugSeverity;
}

/**
 * One fixture's recorded outcome: what a re-run has to reproduce.
 *
 * @since 1.0.0
 * @category models
 */
export interface BaselineRecord {
  fixture: string;
  status: string;
  matches: number;
  falsePositives: number;
  falseNegatives: number;
  anchors: BaselineAnchor[];
}

/**
 * Every fixture's recorded outcome.
 *
 * @since 1.0.0
 * @category models
 */
export interface Baseline {
  version: number;
  reviewer: "deterministic";
  records: BaselineRecord[];
}

/**
 * The shape {@link baselineFrom} writes.
 *
 * Version 1 recorded only status and counts. Version 2 adds {@link
 * BaselineAnchor}, so a baseline written by the older shape has to be
 * re-recorded rather than silently compared against a narrower gate.
 *
 * @since 1.0.0
 * @category constants
 */
export const BASELINE_VERSION = 2;

/**
 * Reduces a run to the record the gate compares.
 *
 * @since 1.0.0
 * @category constructors
 */
export function baselineFrom(
  labels: readonly PlantedBugLabel[],
  runs: readonly FixtureOutcome[],
  score: CorpusScore,
): Baseline {
  const byFixture = new Map(score.fixtures.map((fixture) => [fixture.fixture, fixture]));
  const plantedByFixture = new Map<string, SeededBugLabel[]>();
  for (const label of labels) {
    if (label.clean) continue;
    plantedByFixture.set(label.fixture, [...(plantedByFixture.get(label.fixture) ?? []), label]);
  }
  const matchByLabel = new Map<SeededBugLabel, MatchedFinding>(
    score.matches.map((match) => [match.label, match]),
  );
  return {
    version: BASELINE_VERSION,
    reviewer: "deterministic",
    records: runs
      .map((fixtureRun) => {
        const scored = byFixture.get(fixtureRun.fixture);
        return {
          fixture: fixtureRun.fixture,
          status: fixtureRun.status,
          matches: scored?.matches ?? 0,
          falsePositives: scored?.falsePositives ?? 0,
          falseNegatives: scored?.falseNegatives ?? 0,
          anchors: (plantedByFixture.get(fixtureRun.fixture) ?? []).map((label) => {
            const match = matchByLabel.get(label);
            return {
              path: label.file,
              line: label.line,
              anchoredLine: match?.findingLine ?? null,
              severity: match?.finding.severity ?? null,
              expectedSeverity: label.severity,
            };
          }),
        };
      })
      .sort((left, right) => left.fixture.localeCompare(right.fixture)),
  };
}

/**
 * Every way this run disagrees with the baseline, in report order.
 *
 * @since 1.0.0
 * @category combinators
 */
export function drift(baseline: Baseline, current: Baseline): string[] {
  if (baseline.version !== current.version) {
    return [`baseline version ${baseline.version} -> ${current.version}: re-record with --update`];
  }
  const expected = new Map(baseline.records.map((record) => [record.fixture, record]));
  const out: string[] = [];
  for (const record of current.records) {
    const was = expected.get(record.fixture);
    if (was === undefined) {
      out.push(`${record.fixture}: not in the baseline`);
      continue;
    }
    expected.delete(record.fixture);
    if (record.status !== was.status) out.push(`${record.fixture}: status ${was.status} -> ${record.status}`);
    // Fewer matches or more false positives is a regression. The reverse is an
    // improvement, and an improvement still has to be recorded on purpose.
    if (record.matches !== was.matches) {
      out.push(`${record.fixture}: matched bugs ${was.matches} -> ${record.matches}`);
    }
    if (record.falsePositives !== was.falsePositives) {
      out.push(`${record.fixture}: false positives ${was.falsePositives} -> ${record.falsePositives}`);
    }
    if (record.falseNegatives !== was.falseNegatives) {
      out.push(`${record.fixture}: missed bugs ${was.falseNegatives} -> ${record.falseNegatives}`);
    }
    out.push(...anchorDrift(record, was));
  }
  for (const fixture of expected.keys()) out.push(`${fixture}: in the baseline but not in this run`);
  return out;
}

function describeLine(line: number | null): string {
  return line == null ? "missed" : String(line);
}

function describeSeverity(severity: SeededBugSeverity | null): string {
  return severity ?? "missed";
}

/** Where this fixture's findings landed and how they graded, against the record. */
function anchorDrift(record: BaselineRecord, was: BaselineRecord): string[] {
  const out: string[] = [];
  if (record.anchors.length !== was.anchors.length) {
    out.push(`${record.fixture}: planted bugs ${was.anchors.length} -> ${record.anchors.length}`);
    return out;
  }
  for (let index = 0; index < record.anchors.length; index += 1) {
    const now = record.anchors[index];
    const before = was.anchors[index];
    const bug = `${before.path}:${before.line}`;
    if (now.path !== before.path || now.line !== before.line) {
      out.push(`${record.fixture}: planted bug ${bug} -> ${now.path}:${now.line}`);
      continue;
    }
    if (now.expectedSeverity !== before.expectedSeverity) {
      out.push(`${record.fixture}: ${bug} labelled severity ${before.expectedSeverity} -> ${now.expectedSeverity}`);
    }
    if (now.anchoredLine !== before.anchoredLine) {
      out.push(
        `${record.fixture}: ${bug} anchored at ${describeLine(before.anchoredLine)} -> ${describeLine(now.anchoredLine)}`,
      );
    }
    if (now.severity !== before.severity) {
      out.push(
        `${record.fixture}: ${bug} severity ${describeSeverity(before.severity)} -> ${describeSeverity(now.severity)}`,
      );
    }
  }
  return out;
}
