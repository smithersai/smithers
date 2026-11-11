/**
 * The offline reviewer the seeded-bug suite gates on.
 *
 * A live model is not reproducible and costs money, so the committed baseline
 * cannot be a model's score. This is what it measures instead: a small,
 * deterministic reviewer that reads the same per-file prompt a real seat reads
 * and reports findings from a handful of textual signals in the added lines.
 *
 * What a green gate therefore proves is the PIPELINE, not the model — diff
 * ingestion, per-file fan-out, scoping, anchoring, de-duplication, and the
 * scorer's matching — because that is the half of the eval a code change can
 * break. The model's own score is what `--live` measures, and its numbers
 * belong in `SCORECARD.md`, not in a gate.
 *
 * The reviewer never reads `label.json`. A reviewer that did would score
 * perfectly and measure nothing.
 *
 * @since 1.0.0
 */

/** One finding, in the review action's own output shape. */
interface Finding {
  path: string;
  content: string;
  severity: "critical" | "major" | "minor" | "info";
  category: "correctness" | "security" | "performance" | "tests" | "other";
  confidence: "confirmed" | "plausible";
  startLine: number;
  endLine: number;
  existingCode: string;
  suggestionCode: string;
  thinking: string;
}

/** One added line of a unified diff, with its new-side line number. */
interface AddedLine {
  line: number;
  text: string;
}

/** One line a hunk replaced: the text before, the text after, and where. */
interface ReplacedLine {
  line: number;
  before: string;
  after: string;
}

/**
 * Walks a unified diff and yields every added line with its new-side number.
 *
 * @since 1.0.0
 * @category constructors
 */
export function addedLines(diff: string): AddedLine[] {
  const out: AddedLine[] = [];
  let cursor = 0;
  for (const raw of diff.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      cursor = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (raw.startsWith("+")) {
      out.push({ line: cursor, text: raw.slice(1) });
      cursor += 1;
      continue;
    }
    if (raw.startsWith("-")) continue;
    if (raw.startsWith(" ") || raw === "") cursor += 1;
  }
  return out;
}

/**
 * Pairs each removed line in a hunk with the added line at the same position.
 *
 * A replacement is where most defects live, and some are only visible as a
 * pair: a line that lost its `await` reads perfectly well on its own. Pairing
 * is positional within a hunk's contiguous `-`/`+` run, which is what a unified
 * diff's own structure gives.
 *
 * @since 1.0.0
 * @category constructors
 */
export function replacedLines(diff: string): ReplacedLine[] {
  const out: ReplacedLine[] = [];
  let cursor = 0;
  let removed: string[] = [];
  let added: Array<{ line: number; text: string }> = [];
  const flush = () => {
    for (let index = 0; index < Math.min(removed.length, added.length); index += 1) {
      out.push({ line: added[index].line, before: removed[index], after: added[index].text });
    }
    removed = [];
    added = [];
  };
  for (const raw of diff.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      flush();
      cursor = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+++") || raw.startsWith("---")) continue;
    if (raw.startsWith("-")) {
      removed.push(raw.slice(1));
      continue;
    }
    if (raw.startsWith("+")) {
      added.push({ line: cursor, text: raw.slice(1) });
      cursor += 1;
      continue;
    }
    flush();
    if (raw.startsWith(" ") || raw === "") cursor += 1;
  }
  flush();
  return out;
}

/** One signal read from a replacement pair. */
interface PairSignal {
  readonly test: (before: string, after: string) => boolean;
  readonly severity: Finding["severity"];
  readonly category: Finding["category"];
  readonly content: string;
}

const PAIR_SIGNALS: ReadonlyArray<PairSignal> = [
  {
    // The line kept its call and lost its `await`.
    test: (before, after) =>
      /\bawait\b/.test(before) &&
      !/\bawait\b/.test(after) &&
      before.replace(/\bawait\s+/g, "").trim() === after.trim(),
    severity: "major",
    category: "correctness",
    content: "This line dropped its `await`, so the code below observes a promise instead of its result.",
  },
  {
    // A guard that lost a fallback: `a ?? b` or `a || b` became `a`.
    test: (before, after) => {
      const stripped = before.replace(/\s*(?:\?\?|\|\|)\s*[^;]+/, "");
      return /(?:\?\?|\|\|)/.test(before) && !/(?:\?\?|\|\|)/.test(after) && stripped.trim() === after.trim();
    },
    severity: "major",
    category: "correctness",
    content: "The fallback on this line was removed, so a null or undefined value now flows on unguarded.",
  },
];

/** One signal: what to look for, and what to say about it. */
interface Signal {
  readonly test: (text: string) => boolean;
  readonly severity: Finding["severity"];
  readonly category: Finding["category"];
  readonly content: string;
}

const SIGNALS: ReadonlyArray<Signal> = [
  {
    // A call whose name says it is asynchronous, on a line with no `await`,
    // no `return`, and no `.then`.
    test: (text) =>
      /\b(?:flush|save|persist|commit|write|send|close|drain|sync)[A-Za-z]*\s*\(/.test(text) &&
      !/\bawait\b/.test(text) &&
      !/\breturn\b/.test(text) &&
      !/\.then\s*\(/.test(text) &&
      !/^\s*(?:\/\/|\*|function|async|export|import)/.test(text),
    severity: "major",
    category: "correctness",
    content: "This call looks asynchronous but its result is neither awaited nor returned.",
  },
  {
    // A SQL string built by interpolation rather than by parameter binding.
    test: (text) =>
      /(?:SELECT|INSERT|UPDATE|DELETE)\b/i.test(text) && (/\$\{/.test(text) || /["']\s*\+\s*\w/.test(text)),
    severity: "critical",
    category: "security",
    content: "The query is built by string interpolation, so a caller's value can change its shape.",
  },
  {
    // A boundary comparison that excludes its own endpoint.
    test: (text) => /[<>]\s*[\w.]+\s*[-+]\s*1\b/.test(text) || /\bslice\s*\([^)]*[-+]\s*1\s*\)/.test(text),
    severity: "major",
    category: "correctness",
    content: "The boundary arithmetic excludes one end of the range.",
  },
  {
    // An assertion that compares a value with itself.
    test: (text) => /expect\s*\(\s*([\w.[\]]+)\s*\)\s*\.\s*to\w*\s*\(\s*\1\s*\)/.test(text),
    severity: "minor",
    category: "tests",
    content: "This assertion compares a value with itself, so it can never fail.",
  },
  {
    // A condition holding both a term and its negation: always false under &&,
    // always true under ||.
    test: (text) => {
      const contradiction = /!\s*([\w.]+)\s*&&\s*\1\b|\b([\w.]+)\s*&&\s*!\s*\2\b/;
      const tautology = /!\s*([\w.]+)\s*\|\|\s*\1\b|\b([\w.]+)\s*\|\|\s*!\s*\2\b/;
      return contradiction.test(text) || tautology.test(text);
    },
    severity: "minor",
    category: "tests",
    content: "This condition holds a term and its own negation, so its value never depends on that term.",
  },
];

/**
 * Reviews one file's diff.
 *
 * @since 1.0.0
 * @category constructors
 */
export function reviewDiff(path: string, diff: string): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const record = (line: number, text: string, signal: Signal | PairSignal) => {
    const key = `${signal.content}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({
      path,
      content: signal.content,
      severity: signal.severity,
      category: signal.category,
      confidence: "plausible",
      startLine: line,
      endLine: line,
      existingCode: text.trim(),
      suggestionCode: "",
      thinking: "",
    });
  };
  for (const replaced of replacedLines(diff)) {
    for (const signal of PAIR_SIGNALS) {
      if (signal.test(replaced.before, replaced.after)) record(replaced.line, replaced.after, signal);
    }
  }
  for (const added of addedLines(diff)) {
    for (const signal of SIGNALS) {
      if (signal.test(added.text)) record(added.line, added.text, signal);
    }
  }
  return findings;
}

/**
 * Recovers the file under review and its diff from the per-file prompt.
 *
 * `renderFileReviewPrompt` states the path on a `Current file path:` line and
 * closes with the unified diff in a ```diff fence, so both are addressable
 * without the reviewer knowing anything else about the prompt.
 *
 * @since 1.0.0
 * @category constructors
 */
export function readPrompt(ask: string): { path: string; diff: string } | null {
  const path = /^Current file path:\s*(\S+)$/m.exec(ask)?.[1];
  if (path === undefined) return null;
  const fenced = /```diff\n([\s\S]*?)\n```/g;
  let diff = "";
  for (const match of ask.matchAll(fenced)) diff += `${match[1]}\n`;
  return diff === "" ? null : { path, diff };
}

/**
 * Answers one review ask the way a scripted seat does.
 *
 * @since 1.0.0
 * @category constructors
 * @throws {never}
 */
export function answerReview(ask: string): unknown {
  const read = readPrompt(ask);
  return {
    status: "success",
    message: "",
    summary: null,
    warnings: [],
    comments: read === null ? [] : reviewDiff(read.path, read.diff),
  };
}
