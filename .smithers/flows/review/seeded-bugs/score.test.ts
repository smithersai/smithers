import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Baseline, baselineFrom, drift } from "./baseline.ts";
import { BUG_CLASSES, loadCorpus, type PlantedBugLabel, type SeededBugLabel } from "./labels.vibe";
import { scoreCorpus, type ReviewFinding } from "./score.ts";

const corpusDir = join(import.meta.dirname, "corpus");

function seededLabels(labels: readonly PlantedBugLabel[]): SeededBugLabel[] {
  return labels.filter((label): label is SeededBugLabel => !label.clean);
}

function lineCount(contents: string): number {
  const normalized = contents.replaceAll("\r\n", "\n");
  const withoutTrailingNewline = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return withoutTrailingNewline.length === 0 ? 0 : withoutTrailingNewline.split("\n").length;
}

function findingFor(label: SeededBugLabel, overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    path: label.file,
    content: label.description,
    startLine: label.line,
    endLine: label.line,
    severity: label.severity,
    category: label.category,
    confidence: "confirmed",
    ...overrides,
  };
}

function perfectFindings(labels: readonly PlantedBugLabel[]): Record<string, ReviewFinding[]> {
  return Object.fromEntries(seededLabels(labels).map((label) => [label.fixture, [findingFor(label)]]));
}

describe("review seeded-bug corpus", () => {
  test("labels point at real fixture files and cover every required bug class", () => {
    const labels = loadCorpus();
    const bugLabels = seededLabels(labels);
    const cleanLabels = labels.filter((label) => label.clean);

    for (const bugClass of BUG_CLASSES) {
      expect(bugLabels.filter((label) => label.bugClass === bugClass).length).toBeGreaterThanOrEqual(1);
    }
    expect(cleanLabels.length).toBeGreaterThanOrEqual(2);
    expect(labels.length).toBeGreaterThanOrEqual(15);
    expect(bugLabels.length).toBeGreaterThanOrEqual(12);
    expect(cleanLabels.length).toBeGreaterThanOrEqual(4);

    for (const label of labels) {
      const baseDir = join(corpusDir, label.fixture, "base");
      const headDir = join(corpusDir, label.fixture, "head");
      expect(existsSync(baseDir)).toBe(true);
      expect(existsSync(headDir)).toBe(true);

      if (label.clean) {
        expect("file" in label).toBe(false);
        expect("line" in label).toBe(false);
        continue;
      }

      const headFile = join(headDir, label.file);
      expect(existsSync(headFile)).toBe(true);
      const lines = lineCount(readFileSync(headFile, "utf8"));
      expect(label.line).toBeGreaterThanOrEqual(1);
      expect(label.line).toBeLessThanOrEqual(lines);
    }
  });
});

describe("review seeded-bug scoring", () => {
  test("scores a perfect synthetic finding set as full recall and precision", () => {
    const labels = loadCorpus();
    const score = scoreCorpus(labels, perfectFindings(labels));

    expect(score.recall).toBe(1);
    expect(score.precision).toBe(1);
    expect(score.counts.truePositives).toBe(seededLabels(labels).length);
    expect(score.counts.falsePositives).toBe(0);
    expect(score.anchorAccuracy.meanLineOffset).toBe(0);
    expect(score.anchorAccuracy.meanAbsoluteLineOffset).toBe(0);
    expect(score.anchorAccuracy.fractionWithinTightTolerance).toBe(1);
    expect(score.severityCalibration.exactSeverityMatchRate).toBe(1);
    expect(score.severityCalibration.meanAbsoluteOrdinalError).toBe(0);
  });

  test("counts a finding on a clean control as a false positive", () => {
    const labels = loadCorpus();
    const findings = perfectFindings(labels);
    const cleanControl = labels.find((label) => label.clean);
    expect(cleanControl).toBeDefined();
    findings[cleanControl!.fixture] = [
      {
        path: "src/errors.ts",
        content: "Synthetic spurious clean-control finding.",
        startLine: 1,
        endLine: 1,
        severity: "minor",
        category: "correctness",
        confidence: "plausible",
      },
    ];

    const plantedCount = seededLabels(labels).length;
    const score = scoreCorpus(labels, findings);
    expect(score.recall).toBe(1);
    expect(score.precision).toBe(plantedCount / (plantedCount + 1));
    expect(score.counts.falsePositives).toBe(1);
    const precision = plantedCount / (plantedCount + 1);
    expect(score.f1).toBe((2 * precision) / (precision + 1));
  });

  test("reports F1 as the harmonic mean of precision and recall", () => {
    const labels = loadCorpus();
    expect(scoreCorpus(labels, perfectFindings(labels)).f1).toBe(1);

    // Silence scores perfect precision by the empty-denominator convention, so
    // only F1 exposes that a reviewer which reports nothing has found nothing.
    const silent = scoreCorpus(labels, {});
    expect(silent.precision).toBe(1);
    expect(silent.recall).toBe(0);
    expect(silent.f1).toBe(0);
  });

  test("keeps tolerant anchor matches but records tight-anchor accuracy", () => {
    const labels = loadCorpus();
    const bugLabels = seededLabels(labels);
    const findings = perfectFindings(labels);
    const shifted = bugLabels[0];
    findings[shifted.fixture] = [findingFor(shifted, { startLine: shifted.line + 2, endLine: shifted.line + 2 })];

    const score = scoreCorpus(labels, findings, { matchTolerance: 3, tightTolerance: 1 });
    expect(score.recall).toBe(1);
    expect(score.precision).toBe(1);
    expect(score.anchorAccuracy.meanLineOffset).toBe(2 / bugLabels.length);
    expect(score.anchorAccuracy.meanAbsoluteLineOffset).toBe(2 / bugLabels.length);
    expect(score.anchorAccuracy.fractionWithinTightTolerance).toBe((bugLabels.length - 1) / bugLabels.length);
  });

  test("measures severity calibration for matched findings", () => {
    const labels = loadCorpus();
    const bugLabels = seededLabels(labels);
    const findings = perfectFindings(labels);
    const changed = bugLabels.find((label) => label.severity === "major");
    expect(changed).toBeDefined();
    findings[changed!.fixture] = [findingFor(changed!, { severity: "info" })];

    const score = scoreCorpus(labels, findings);
    expect(score.recall).toBe(1);
    expect(score.precision).toBe(1);
    expect(score.severityCalibration.exactSeverityMatchRate).toBe((bugLabels.length - 1) / bugLabels.length);
    expect(score.severityCalibration.meanAbsoluteOrdinalError).toBe(2 / bugLabels.length);
  });
});

function successfulRuns(labels: readonly PlantedBugLabel[]): { fixture: string; status: string }[] {
  return labels.map((label) => ({ fixture: label.fixture, status: "success" }));
}

function committedBaseline(): Baseline {
  return JSON.parse(readFileSync(join(import.meta.dirname, "baseline.json"), "utf8")) as Baseline;
}

describe("review seeded-bug baseline gate", () => {
  test("fails when anchors shift and severities downgrade without moving TP/FP/FN", () => {
    const labels = loadCorpus();
    const runs = successfulRuns(labels);
    const recorded = scoreCorpus(labels, perfectFindings(labels));
    const baseline = baselineFrom(labels, runs, recorded);

    // Every finding moves three lines, the outer edge of the match tolerance,
    // and drops to the lowest severity. The counts the gate used to compare
    // cannot see either move.
    const degradedFindings = Object.fromEntries(
      seededLabels(labels).map((label) => [
        label.fixture,
        [findingFor(label, { startLine: label.line + 3, endLine: label.line + 3, severity: "info" })],
      ]),
    );
    const degraded = scoreCorpus(labels, degradedFindings);
    expect(degraded.counts.truePositives).toBe(recorded.counts.truePositives);
    expect(degraded.counts.falsePositives).toBe(recorded.counts.falsePositives);
    expect(degraded.counts.falseNegatives).toBe(recorded.counts.falseNegatives);
    expect(degraded.anchorAccuracy.meanAbsoluteLineOffset).toBe(3);
    expect(degraded.severityCalibration.exactSeverityMatchRate).toBe(0);

    const disagreements = drift(baseline, baselineFrom(labels, runs, degraded));
    expect(disagreements.length).toBeGreaterThan(0);
    expect(disagreements.some((line) => line.includes("anchored"))).toBe(true);
    expect(disagreements.some((line) => line.includes("severity"))).toBe(true);
  });

  test("passes when the run reproduces the recorded anchors and severities", () => {
    const labels = loadCorpus();
    const runs = successfulRuns(labels);
    const score = scoreCorpus(labels, perfectFindings(labels));
    expect(drift(baselineFrom(labels, runs, score), baselineFrom(labels, runs, score))).toEqual([]);
  });

  test("records an anchor and a severity for every planted bug", () => {
    const labels = loadCorpus();
    const baseline = committedBaseline();

    for (const label of seededLabels(labels)) {
      const record = baseline.records.find((candidate) => candidate.fixture === label.fixture);
      expect(record).toBeDefined();
      const anchor = record!.anchors.find(
        (candidate) => candidate.path === label.file && candidate.line === label.line,
      );
      expect(anchor).toBeDefined();
      expect(anchor!.expectedSeverity).toBe(label.severity);
      expect(record!.anchors.filter((candidate) => candidate.anchoredLine !== null).length).toBe(record!.matches);
    }
  });
});

describe("review seeded-bug scorecard", () => {
  test("names every fixture the committed baseline misses", () => {
    const missed = committedBaseline()
      .records.filter((record) => record.falseNegatives > 0)
      .map((record) => record.fixture)
      .sort((left, right) => left.localeCompare(right));
    expect(missed.length).toBeGreaterThan(0);

    const scorecard = readFileSync(join(import.meta.dirname, "SCORECARD.md"), "utf8");
    const section = scorecard.split("### Missed fixtures")[1];
    expect(section).toBeDefined();
    const listed = [...section!.split(/\n#{2,3} /)[0].matchAll(/^- `([^`]+)`$/gm)].map((match) => match[1]);
    expect(listed).toEqual(missed);
  });
});
