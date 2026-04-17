#!/usr/bin/env bun
/**
 * Reduce the token footprint of docs/llms-full.txt without losing information.
 *
 * Operates only on docs/llms-full.txt (the LLM artifact). The MDX source is
 * left untouched because Mintlify-rendered docs still benefit from cross-link
 * URLs, "Next Steps" navigation, and per-page Source headers for human readers.
 *
 * Transforms applied:
 *   1. Drop "Next Steps" / "Read Next" / "Related" / "See Also" sections.
 *      Pure navigation; an LLM holding the full corpus does not need them.
 *   2. Strip the URL from internal cross-reference links: [text](/path) -> text.
 *      External URLs (http/https) are kept on their first occurrence per page.
 *   3. Drop per-page "> Source: https://smithers.sh/..." blockquote lines.
 *   4. Collapse adjacent "---" separators that are now next to each other or
 *      doubled inside type/component reference pages.
 *   5. Compact CLI bash code blocks: keep at most 2 example invocations per
 *      command (canonical form + one combined-flag example), drop the rest.
 *   6. Strip JSX pragma comments after the first occurrence:
 *      `/** @jsxImportSource smithers-orchestrator *\/` is repeated in dozens
 *      of TSX snippets. Keep the first occurrence in the file as a reference.
 *
 * Run: bun scripts/optimize-llms-full.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const TARGET = resolve(import.meta.dir, "../docs/llms-full.txt");
const before = readFileSync(TARGET, "utf8");
let text = before;

// --- 1. Remove navigation sections ------------------------------------------
//
// Pages end with one of: "## Next Steps", "## Next steps", "## Read Next",
// "## Related", "## See Also". These run until the next "## " heading,
// the next "---" page separator, or end-of-file.
{
  const NAV_HEADINGS = [
    "Next Steps",
    "Next steps",
    "Read Next",
    "Related",
    "See Also",
    "See also",
  ];
  const headingAlt = NAV_HEADINGS.map((h) => h.replace(/ /g, "\\s+")).join("|");
  // Match: heading line + everything until the next ## heading or --- separator.
  const re = new RegExp(
    String.raw`(^|\n)##\s+(?:${headingAlt})\s*\n[\s\S]*?(?=\n##\s|\n---\s*\n|$)`,
    "g",
  );
  text = text.replace(re, (_m, lead) => lead);
}

// --- 2. Strip internal cross-ref URLs ---------------------------------------
//
// [text](/path) and [text](#anchor) -> text.
// Keep external links (http://, https://, mailto:) intact.
text = text.replace(/\[([^\]\n]+?)\]\((\/[^)\n\s]*|#[^)\n\s]*)\)/g, "$1");

// --- 3. Drop per-page Source: blockquote lines ------------------------------
text = text.replace(/^>\s*Source:\s*https?:\/\/[^\s]+\s*\n/gm, "");

// --- 3b. Drop duplicate H1 immediately after the page H2 --------------------
//
// Pages render as:
//   ## Page Title
//   > Summary...
//   # Page Title          <-- duplicate of the H2 above
//
// Drop the H1 when its text matches the immediately-preceding H2.
{
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h1 = /^#\s+(.+?)\s*$/.exec(line);
    if (h1) {
      // Look back through up to 5 prior lines for a "## " heading with the
      // same text. Skip blanks and blockquote lines.
      let foundH2: string | null = null;
      for (let k = out.length - 1, hops = 0; k >= 0 && hops < 6; k--, hops++) {
        const prior = out[k];
        if (prior.trim() === "" || prior.startsWith(">")) continue;
        const h2 = /^##\s+(.+?)\s*$/.exec(prior);
        if (h2) foundH2 = h2[1].trim();
        break;
      }
      if (foundH2 && foundH2 === h1[1].trim()) {
        // Skip this duplicate H1.
        continue;
      }
    }
    out.push(line);
  }
  text = out.join("\n");
}
// And the "> GitHub:" / "> Package:" pair near the top — fold to a single
// reference line.
text = text.replace(
  /^>\s*GitHub:\s*[^\n]+\n>\s*Package:\s*[^\n]+\n/m,
  "> Repo: github.com/evmts/smithers · Package: smithers-orchestrator (npm)\n",
);

// --- 4. Collapse adjacent / doubled separators ------------------------------
//
// After removing nav sections we sometimes leave "---\n---". Collapse runs of
// blank lines + "---" separators down to a single instance.
text = text.replace(/(?:\n\s*---\s*){2,}/g, "\n---\n");
// Also collapse 3+ consecutive blank lines down to 2.
text = text.replace(/\n{4,}/g, "\n\n\n");

// --- 5. Compact CLI bash example variants -----------------------------------
//
// CLI reference pages emit blocks like:
//
//   ```bash
//   bunx smithers-orchestrator ps
//   bunx smithers-orchestrator ps --status waiting-approval
//   bunx smithers-orchestrator ps --limit 50
//   bunx smithers-orchestrator ps --watch --interval 5
//   ```
//
// Keep the first (canonical) line and at most one combined-flag variant
// (the one with the most flags). Drop the rest.
text = text.replace(
  /```bash\n([\s\S]*?)\n```/g,
  (full, body: string) => {
    const lines = body.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length < 4) return full;
    // Group consecutive lines that share the same first 3 tokens (e.g.
    // "bunx smithers-orchestrator ps").
    const groups: string[][] = [];
    let cur: string[] = [];
    let curKey = "";
    for (const line of lines) {
      const key = line.trim().split(/\s+/).slice(0, 3).join(" ");
      if (key === curKey) {
        cur.push(line);
      } else {
        if (cur.length) groups.push(cur);
        cur = [line];
        curKey = key;
      }
    }
    if (cur.length) groups.push(cur);

    const kept: string[] = [];
    let collapsed = false;
    for (const g of groups) {
      if (g.length <= 2) {
        kept.push(...g);
      } else {
        // Keep first (canonical) and the line with the most --flags.
        const first = g[0];
        let best = g[1];
        let bestFlags = (best.match(/--/g) ?? []).length;
        for (let i = 2; i < g.length; i++) {
          const f = (g[i].match(/--/g) ?? []).length;
          if (f > bestFlags) {
            best = g[i];
            bestFlags = f;
          }
        }
        kept.push(first, best);
        collapsed = true;
      }
    }
    if (!collapsed) return full;
    return "```bash\n" + kept.join("\n") + "\n```";
  },
);

// --- 6. Strip repeated JSX pragma comments after first occurrence -----------
{
  const PRAGMA = "/** @jsxImportSource smithers-orchestrator */";
  let first = true;
  text = text.replace(/\/\*\* @jsxImportSource smithers-orchestrator \*\/\n?/g, () => {
    if (first) {
      first = false;
      return PRAGMA + "\n";
    }
    return "";
  });
}

// --- 7. Dedupe `ts` interface block + immediately-following field table -----
//
// Type-reference pages emit a `ts` code block followed (within a few blank
// lines) by a markdown table. The table carries strictly more information
// (Default, Description) than the interface block, so drop the ts block.
//
// Implemented as a line-by-line state machine to guarantee we never cross
// another fenced block (the previous regex-based version was unsafe).
{
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Detect opening of a ts/typescript fence.
    const fence = /^(\s*)```(ts|typescript)\s*$/.exec(line);
    if (!fence) {
      out.push(line);
      i++;
      continue;
    }
    // Find closing fence, capturing the body.
    let j = i + 1;
    while (j < lines.length && !/^\s*```\s*$/.test(lines[j])) j++;
    if (j >= lines.length) {
      // Unterminated fence — emit as-is.
      out.push(line);
      i++;
      continue;
    }
    const bodyLines = lines.slice(i + 1, j);
    const closingFence = lines[j];
    // Look ahead for a table header within up to 3 blank lines.
    let k = j + 1;
    let blanks = 0;
    while (k < lines.length && lines[k].trim() === "" && blanks < 3) {
      blanks++;
      k++;
    }
    const followingHeader = k < lines.length ? lines[k] : "";
    const followingDivider = k + 1 < lines.length ? lines[k + 1] : "";
    const isTableHeader =
      /^\|.*\|\s*$/.test(followingHeader) &&
      /^\|[-:|\s]+\|\s*$/.test(followingDivider);
    // Decide whether to drop the ts block.
    let drop = false;
    if (isTableHeader) {
      // Heuristic: drop only when the table header looks like a field/prop/
      // value reference (so we don't accidentally drop code adjacent to a
      // narrative table).
      const headerCells = followingHeader
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean);
      const firstCell = headerCells[0]?.toLowerCase() ?? "";
      const isFieldTable = [
        "field",
        "prop",
        "field / method",
        "value",
        "event",
        "code",
        "key",
        "option",
      ].some((k) => firstCell.startsWith(k));
      // Skip dedupe for literal-string union types when the table is a 2-col
      // value/description table — the union form is denser.
      const body = bodyLines.join("\n");
      const isLiteralUnion = /=\s*"[^"]+"\s*\|/.test(body);
      const isTwoColValueTable = headerCells.length === 2 && firstCell === "value";
      if (isFieldTable && !(isLiteralUnion && isTwoColValueTable)) {
        drop = true;
      }
    }
    if (drop) {
      // Skip the ts fence + body + closing fence; preserve following blank
      // lines and the table.
      i = j + 1;
      continue;
    }
    // Keep the fence + body + closing fence.
    out.push(line);
    for (const b of bodyLines) out.push(b);
    out.push(closingFence);
    i = j + 1;
  }
  text = out.join("\n");
}

// --- 8. Replace Ghost: source dumps with a single pointer -------------------
//
// "## Ghost: ..." sections are verbatim copies of files already present in
// the repo (workflows/, scripts/, plugin manifests, AGENTS.md, etc.).
// Walk lines; once we hit the first "## Ghost: ", swallow everything until the
// next "## " heading that is NOT itself a Ghost section.
{
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  let inGhostBlock = false;
  let replacedOnce = false;
  // Ghost sections each contain nested "## Source", "## Running", etc., so we
  // can't use H2 headings as boundaries. They are reliably bounded by the
  // page-separator pattern: a line containing exactly "---" surrounded by
  // blank lines. To exit, we need a "---" page separator that is followed by
  // a non-Ghost "## " heading.
  const isPageSeparator = (idx: number) => {
    if (lines[idx]?.trim() !== "---") return false;
    // Look ahead, skipping blanks, for the next non-blank line.
    let k = idx + 1;
    while (k < lines.length && lines[k].trim() === "") k++;
    if (k >= lines.length) return true;
    return /^##\s/.test(lines[k]);
  };
  while (i < lines.length) {
    const line = lines[i];
    if (!inGhostBlock) {
      if (/^## Ghost: /.test(line)) {
        inGhostBlock = true;
        if (!replacedOnce) {
          // Drop trailing blank line(s) and any preceding "---" so we don't
          // leave a stray separator above our replacement.
          while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
          if (out.length > 0 && out[out.length - 1].trim() === "---") out.pop();
          while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
          out.push("");
          out.push("---");
          out.push("");
          out.push("## Repository Examples (Ghost Docs)");
          out.push("");
          out.push(
            "Verbatim source files for seeded workflows, plugin manifests, and CI configuration are not duplicated here.",
          );
          out.push(
            "After `bunx smithers-orchestrator init`, browse `.smithers/` for live copies.",
          );
          out.push(
            "For repo-level files (`AGENTS.md`, `.github/workflows/ci.yml`, `~/.claude/plugins/smithers-orchestrator/`, etc.) see the source repository at github.com/evmts/smithers.",
          );
          replacedOnce = true;
        }
        i++;
        continue;
      }
      out.push(line);
      i++;
      continue;
    }
    // Inside the Ghost block. Look for a page separator whose next non-blank
    // line is a "## " heading that is NOT another Ghost: section.
    if (isPageSeparator(i)) {
      // Find the next ## heading.
      let k = i + 1;
      while (k < lines.length && lines[k].trim() === "") k++;
      if (k < lines.length && /^##\s/.test(lines[k]) && !/^## Ghost: /.test(lines[k])) {
        // Exit Ghost block: emit the separator + blank + heading and continue.
        inGhostBlock = false;
        out.push(""); // blank line before separator
        out.push("---");
        out.push("");
        out.push(lines[k]);
        i = k + 1;
        continue;
      }
      // Otherwise: we're transitioning between Ghost sections. Just skip.
    }
    i++;
  }
  text = out.join("\n");
}

// --- 9. Trim verbose external link descriptions -----------------------------
//
// Many external links repeat the same target many times: [Zod](https://zod.dev),
// [Bun](https://bun.sh), [Anthropic](https://docs.anthropic.com), etc.
// Keep the first occurrence with its URL; subsequent occurrences become bare
// link text.
{
  const seen = new Set<string>();
  text = text.replace(
    /\[([^\]\n]+?)\]\((https?:\/\/[^)\n\s]+)\)/g,
    (full, label: string, url: string) => {
      const key = url;
      if (seen.has(key)) return label;
      seen.add(key);
      return full;
    },
  );
}

// Final tidy: re-collapse adjacent --- separators (Ghost replacement may have
// introduced new ones), trim trailing whitespace, and squeeze blank-line runs.
// Collapse runs of "---" page separators (with arbitrary blank lines between)
// down to a single separator.
text = text.replace(/(?:\n[ \t]*---[ \t]*\n(?:[ \t]*\n)*){2,}/g, "\n---\n\n");
text = text
  .split("\n")
  .map((l) => l.replace(/[ \t]+$/, ""))
  .join("\n");
text = text.replace(/\n{4,}/g, "\n\n\n");

if (text === before) {
  console.log("No changes.");
  process.exit(0);
}

writeFileSync(TARGET, text);
const beforeBytes = before.length;
const afterBytes = text.length;
const beforeTokens = Math.round(beforeBytes / 4);
const afterTokens = Math.round(afterBytes / 4);
const pct = (((beforeBytes - afterBytes) / beforeBytes) * 100).toFixed(1);
console.log(`docs/llms-full.txt`);
console.log(`  bytes:  ${beforeBytes.toLocaleString()} -> ${afterBytes.toLocaleString()}  (-${(beforeBytes - afterBytes).toLocaleString()}, -${pct}%)`);
console.log(`  ~tokens: ${beforeTokens.toLocaleString()} -> ${afterTokens.toLocaleString()}  (-${(beforeTokens - afterTokens).toLocaleString()})`);
