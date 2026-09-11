import type { ReviewComment } from "../workflow/reviewCommentSchema.ts";

type HunkLine = {
  type: "context" | "added" | "deleted";
  content: string;
};

type Hunk = {
  oldStart: number;
  newStart: number;
  lines: HunkLine[];
};

type IndexedLine = {
  lineNum: number;
  anchorLine: number;
  content: string;
};

function parseHunks(diffText: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  for (const line of diffText.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      current = { oldStart: Number(header[1]), newStart: Number(header[2]), lines: [] };
      hunks.push(current);
      continue;
    }
    // File headers precede the first hunk; inside a hunk every diff marker is code.
    if (!current) continue;
    if (line.startsWith("+")) {
      current.lines.push({ type: "added", content: line.slice(1) });
    } else if (line.startsWith("-")) {
      current.lines.push({ type: "deleted", content: line.slice(1) });
    } else if (line.startsWith(" ")) {
      current.lines.push({ type: "context", content: line.slice(1) });
    }
  }
  return hunks;
}

function normalizeCodeLine(value: string) {
  return value.trim().replace(/^[+-]/, "").trim();
}

function splitAndNormalizeCode(value: string) {
  return value.split("\n").map(normalizeCodeLine).filter(Boolean);
}

function extractSideLines(hunk: Hunk, newSide: boolean): IndexedLine[] {
  const result: IndexedLine[] = [];
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  for (const line of hunk.lines) {
    if (line.type === "context") {
      result.push({
        lineNum: newSide ? newLine : oldLine,
        anchorLine: newLine,
        content: normalizeCodeLine(line.content),
      });
      oldLine += 1;
      newLine += 1;
    } else if (line.type === "added") {
      if (newSide) result.push({ lineNum: newLine, anchorLine: newLine, content: normalizeCodeLine(line.content) });
      newLine += 1;
    } else {
      // Deleted line: anchor on the nearest following new-side line so any resolved
      // position stays in new-file numbering (newLine is not advanced for deletions).
      if (!newSide) result.push({ lineNum: oldLine, anchorLine: newLine, content: normalizeCodeLine(line.content) });
      oldLine += 1;
    }
  }
  return result;
}

function collectMatches(sideLines: IndexedLine[], targetLines: string[]) {
  const matches: Array<{ startLine: number; endLine: number }> = [];
  if (targetLines.length === 0 || sideLines.length < targetLines.length) return matches;
  for (let i = 0; i <= sideLines.length - targetLines.length; i += 1) {
    let matched = true;
    for (let j = 0; j < targetLines.length; j += 1) {
      if (sideLines[i + j].content !== targetLines[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      // anchorLine is always in new-file numbering (equal to lineNum on the new side).
      matches.push({
        startLine: sideLines[i].anchorLine,
        endLine: sideLines[i + targetLines.length - 1].anchorLine,
      });
    }
  }
  return matches;
}

function newSideHunkRanges(hunks: Hunk[]) {
  return hunks
    .map((hunk) => {
      const newSideCount = hunk.lines.filter((line) => line.type !== "deleted").length;
      return { start: hunk.newStart, end: hunk.newStart + Math.max(newSideCount - 1, 0) };
    })
    .filter((range) => range.start > 0);
}

function withinNewSideRanges(hunks: Hunk[], startLine: number, endLine: number) {
  return newSideHunkRanges(hunks).some((range) => startLine >= range.start && endLine <= range.end);
}
/**
 * Pins a finding to new-side lines the diff actually contains: keeps in-range
 * lines, otherwise resolves a unique `existingCode` match, otherwise zeroes the
 * anchor so the finding degrades to the unanchored list.
 */
export function anchorFinding(comment: ReviewComment, diffText: string) {
  if (comment.startLine <= 0 && comment.endLine <= 0) {
    return resolveCommentLineNumbers(comment, diffText);
  }
  const startLine = comment.startLine > 0 ? comment.startLine : comment.endLine;
  const endLine = Math.max(comment.endLine, startLine);
  if (withinNewSideRanges(parseHunks(diffText), startLine, endLine)) {
    return { ...comment, startLine, endLine };
  }
  // Agent-supplied lines fall outside the diff's new side. Re-run the deterministic
  // existingCode resolver; if that also fails, zero the anchor so the finding
  // degrades per-finding to the unanchored list instead of failing a whole
  // GitHub review batch later.
  const resolved = resolveCommentLineNumbers({ ...comment, startLine: 0, endLine: 0 }, diffText);
  if (resolved.startLine > 0 || resolved.endLine > 0) return resolved;
  return { ...comment, startLine: 0, endLine: 0 };
}

function resolveCommentLineNumbers(comment: ReviewComment, diffText: string) {
  if (comment.startLine > 0 || comment.endLine > 0 || !comment.existingCode.trim()) return comment;
  const targetLines = splitAndNormalizeCode(comment.existingCode);
  if (targetLines.length === 0) return comment;
  const hunks = parseHunks(diffText);
  // Only assign a position when the snippet matches exactly one place; a non-unique
  // snippet (e.g. a closing brace) can otherwise anchor to the wrong location.
  // Resolve against the new side first, then fall back to deleted lines (whose anchor
  // is the nearest following new-file line) so positions stay in new-file numbering.
  for (const newSide of [true, false]) {
    const matches = hunks.flatMap((hunk) => collectMatches(extractSideLines(hunk, newSide), targetLines));
    if (matches.length === 1) return { ...comment, ...matches[0] };
    if (matches.length > 1) return comment;
  }
  return comment;
}
