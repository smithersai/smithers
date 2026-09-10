import { isTestPath } from "../text/isTestPath.ts";
import type { QuizImpact } from "./quizSchema.ts";

export type ImpactLevel = QuizImpact["level"];

export type ImpactFile = {
  path: string;
  status: string;
  insertions: number;
  deletions: number;
  diff: string;
};

export type ImpactFinding = {
  severity: string;
  category: string;
  path: string;
};

export type ChangeImpact = {
  level: ImpactLevel;
  score: number;
  reasons: Array<{ signal: string; path: string }>;
};

const securityKeywords = [
  "auth",
  "token",
  "secret",
  "crypto",
  "password",
  "session",
  "acl",
  "permission",
  "payment",
  "billing",
  "checkout",
];

const dataKeywords = ["migration", "schema"];

const supplyChainKeywords = ["dockerfile", "deploy", "infra", "terraform"];

const surfaceKeywords = ["api", "handler", "route", "controller"];

// Deliberately excludes broad markers like "process.env", "crypto.", and
// "timing": they flag ordinary code far more often than risky code.
const riskyContentMarkers = [
  "eval(",
  "child_process",
  "exec(",
  "innerHTML",
  "dangerouslySetInnerHTML",
  "DROP TABLE",
  "DELETE FROM",
  "chmod",
];

// Each marker counts at most once per file, and a single file's riskyContent
// contribution is capped at this many hits, so one file cannot reach
// critical from repeated markers alone.
const maxRiskyHitsPerFile = 2;

// Score weights per signal; thresholds documented at levelForScore.
const weights = {
  securityPath: 3,
  dataPath: 3,
  supplyChainPath: 2,
  surfacePath: 1,
  riskyContent: 2,
  criticalFinding: 4,
  securityFinding: 3,
  deletedTest: 3,
};

const churnBumpThreshold = 800;
const fileCountBumpThreshold = 25;

function pathTokens(path: string) {
  return path
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function matchKeyword(tokens: string[], keywords: string[]) {
  return keywords.find((keyword) => tokens.some((token) => token === keyword || token === `${keyword}s`)) ?? "";
}

function addedLines(diff: string) {
  return diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .join("\n");
}

function fileStem(path: string) {
  const name = path.split("/").pop() ?? path;
  const base = name.replace(/\.[^.]+$/, "");
  return base.replace(/[._-](test|spec)$/i, "").toLowerCase();
}

// Thresholds: score 0-2 low, 3-5 moderate, 6-9 high, 10+ critical.
function levelForScore(score: number): ImpactLevel {
  if (score >= 10) return "critical";
  if (score >= 6) return "high";
  if (score >= 3) return "moderate";
  return "low";
}

const levelOrder: ImpactLevel[] = ["low", "moderate", "high", "critical"];

function bumpLevel(level: ImpactLevel): ImpactLevel {
  const next = levelOrder.indexOf(level) + 1;
  return levelOrder[Math.min(next, levelOrder.length - 1)];
}

export function assessChangeImpact(files: ImpactFile[], findings: ImpactFinding[]): ChangeImpact {
  const reasons: Array<{ signal: string; path: string }> = [];
  let score = 0;

  for (const file of files) {
    const lower = file.path.toLowerCase();
    const tokens = pathTokens(file.path);

    const securityHit = matchKeyword(tokens, securityKeywords);
    if (securityHit) {
      score += weights.securityPath;
      reasons.push({ signal: `security-sensitive path (${securityHit})`, path: file.path });
    }

    const dataHit = matchKeyword(tokens, dataKeywords) || (lower.endsWith(".sql") ? "sql" : "");
    if (dataHit) {
      score += weights.dataPath;
      reasons.push({ signal: `data schema or migration path (${dataHit})`, path: file.path });
    }

    const supplyHit =
      matchKeyword(tokens, supplyChainKeywords) ||
      (lower.includes(".github/workflows") ? "github workflow" : "") ||
      (lower.includes("docker-compose") ? "docker-compose" : "");
    if (supplyHit) {
      score += weights.supplyChainPath;
      reasons.push({ signal: `ci or deployment path (${supplyHit})`, path: file.path });
    }

    const surfaceHit = matchKeyword(tokens, surfaceKeywords);
    if (surfaceHit) {
      score += weights.surfacePath;
      reasons.push({ signal: `user-facing surface path (${surfaceHit})`, path: file.path });
    }

    const added = addedLines(file.diff).toLowerCase();
    let riskyHits = 0;
    for (const marker of riskyContentMarkers) {
      if (riskyHits >= maxRiskyHitsPerFile) break;
      if (added.includes(marker.toLowerCase())) {
        riskyHits += 1;
        score += weights.riskyContent;
        reasons.push({ signal: `risky added content (${marker})`, path: file.path });
      }
    }
  }

  for (const finding of findings) {
    if (finding.severity === "critical") {
      score += weights.criticalFinding;
      reasons.push({ signal: "critical finding", path: finding.path });
    }
    const highSeverity = finding.severity === "critical" || finding.severity === "major";
    if (highSeverity && (finding.category === "security" || finding.category === "data-loss")) {
      score += weights.securityFinding;
      reasons.push({ signal: `${finding.category} finding at ${finding.severity} severity`, path: finding.path });
    }
  }

  const changedSourceStems = new Set(
    files.filter((file) => file.status !== "deleted" && !isTestPath(file.path)).map((file) => fileStem(file.path)),
  );
  for (const file of files) {
    if (file.status !== "deleted" || !isTestPath(file.path)) continue;
    if (changedSourceStems.has(fileStem(file.path))) {
      score += weights.deletedTest;
      reasons.push({ signal: "test file deleted while sibling source changed", path: file.path });
    }
  }

  let level = levelForScore(score);

  // Size bumps one level step (it does not add score): sheer churn makes any
  // change harder to review honestly.
  const totalChurn = files.reduce((sum, file) => sum + file.insertions + file.deletions, 0);
  if (totalChurn > churnBumpThreshold || files.length > fileCountBumpThreshold) {
    level = bumpLevel(level);
    reasons.push({ signal: `large change (${totalChurn} lines across ${files.length} files)`, path: "" });
  }

  return { level, score, reasons };
}
