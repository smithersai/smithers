/**
 * Pure wikilink/frontmatter helpers for the vault lane, ported faithfully
 * from the ddd VaultTab implementation in the Smithers 0.x workflow UI pack.
 *
 * Deliberately free of React so tests (and any other consumer) can import the
 * link logic without pulling a browser-shaped dependency tree.
 */

import { stepFence, type Fence } from "./fence";

/** Href prefix for a wikilink rendered into markdown. Scheme-less on purpose:
 *  href sanitizers drop unknown schemes, which would swallow the click. */
export const NOTE_HREF = "#note/";

export function splitFrontmatter(source: string): { frontmatter: string | null; body: string } {
  const match = source.match(/^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/);
  if (!match) return { frontmatter: null, body: source };
  return { frontmatter: match[1] ?? "", body: source.slice(match[0].length) };
}

export function joinFrontmatter(frontmatter: string | null, body: string): string {
  if (frontmatter === null) return body;
  return `---\n${frontmatter}\n---\n${body}`;
}

/**
 * Some markdown serializers escape literal square brackets, turning
 * `[[Note]]` into `\[\[Note]]` and severing the vault's link graph on save.
 * Every edit is run through this before it becomes file content.
 */
export function restoreWikilinks(markdown: string): string {
  return markdown.replaceAll("\\[\\[", "[[").replaceAll("\\]\\]", "]]");
}

export function noteHref(path: string): string {
  return `${NOTE_HREF}${encodeURIComponent(path).replace(/[()]/g, (char) => "%" + char.charCodeAt(0).toString(16))}`;
}

/** Decode a click href back to a vault path, or "" when it is not a wikilink. */
export function pathFromHref(href: string): string {
  if (!href.startsWith(NOTE_HREF)) return "";
  try {
    return decodeURIComponent(href.slice(NOTE_HREF.length));
  } catch {
    return "";
  }
}

export function noteLabel(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/, "");
}

/** One run of markdown text, tagged with whether it is code. */
type Segment = { readonly text: string; readonly code: boolean };

/**
 * Split a line into inline-code and non-code runs, CommonMark style.
 *
 * A code span opens on a run of N backticks and closes on the next run of
 * EXACTLY N. The single-backtick regex this replaced (``/(`[^`]*`)/``) could not
 * see a ``` ``double-backtick`` ``` span at all, so a wikilink inside a valid
 * code span was rewritten into a live note link. An unterminated run is literal
 * text, which is also what CommonMark says.
 *
 * Concatenating every segment's text reproduces the line exactly.
 */
function splitInlineCode(line: string): Segment[] {
  const segments: Segment[] = [];
  let plain = "";
  let index = 0;
  const runLength = (at: number): number => {
    let run = 0;
    while (line[at + run] === "`") run += 1;
    return run;
  };
  while (index < line.length) {
    if (line[index] !== "`") {
      plain += line[index];
      index += 1;
      continue;
    }
    const open = runLength(index);
    let search = index + open;
    let close = -1;
    while (search < line.length) {
      if (line[search] !== "`") {
        search += 1;
        continue;
      }
      const run = runLength(search);
      if (run === open) {
        close = search;
        break;
      }
      search += run;
    }
    if (close === -1) {
      plain += line.slice(index, index + open);
      index += open;
      continue;
    }
    if (plain) {
      segments.push({ text: plain, code: false });
      plain = "";
    }
    segments.push({ text: line.slice(index, close + open), code: true });
    index = close + open;
  }
  if (plain) segments.push({ text: plain, code: false });
  return segments;
}

/**
 * Scan markdown into per-line segments tagged as code or prose. The single
 * scanner behind {@link wikilinksToMarkdown} and {@link parseWikilinks}: they
 * used to carry independent copies of the same flawed logic, so fixing one
 * would have left the other wrong.
 *
 * Fence state comes from the shared {@link stepFence} tracker, which the
 * outline parser reads too: a fence closes only on its own character, at least
 * as long, with nothing after it.
 */
function scanMarkdown(markdown: string): Segment[][] {
  const rows: Segment[][] = [];
  let fence: Fence | null = null;
  for (const line of markdown.split("\n")) {
    const step = stepFence(line, fence);
    fence = step.fence;
    rows.push(step.fenced ? [{ text: line, code: true }] : splitInlineCode(line));
  }
  return rows;
}

/**
 * Rewrite `[[wikilinks]]` into markdown links the shared `Markdown` primitive
 * renders, so clicking one navigates in-app. Links inside fenced or inline code
 * are left alone — Obsidian does not resolve those either. An unresolved link
 * degrades to its plain label rather than a dead anchor.
 */
export function wikilinksToMarkdown(body: string, resolve: (target: string) => string): string {
  return scanMarkdown(body)
    .map((segments) =>
      segments
        .map((segment) => {
          if (segment.code) return segment.text;
          return segment.text.replace(/!?\[\[([^\]\n]+)\]\]/g, (_raw, inner: string) => {
            const [beforeAlias = "", ...aliasParts] = inner.split("|");
            const [target = "", ...headingParts] = beforeAlias.split("#");
            const heading = headingParts.join("#").trim();
            const alias = aliasParts.join("|").trim();
            const label = alias || (target.trim() ? beforeAlias.trim() : `#${heading}`);
            const path = target.trim() ? resolve(target.trim()) : "";
            if (!path) return label;
            return `[${label}](${noteHref(path)})`;
          });
        })
        .join("")
    )
    .join("\n");
}

/** One parsed `[[wikilink]]` occurrence. */
export type Wikilink = {
  /** Link target note name/path (the part before any `#heading` or `|alias`). */
  target: string;
  /** Heading within the target (text after `#`, trimmed); "" when none. */
  heading: string;
  /** Display alias (text after `|`, trimmed); "" when none. */
  alias: string;
  /** True for `![[embeds]]`. */
  embed: boolean;
  /** The full matched source, e.g. `![[Note#Heading|Alias]]`. */
  raw: string;
};

/**
 * Extract every `[[wikilink]]` from markdown, with the same fence/inline-code
 * safety as {@link wikilinksToMarkdown}: occurrences inside fenced or inline
 * code are not links (Obsidian does not resolve those either).
 */
export function parseWikilinks(markdown: string): Wikilink[] {
  const links: Wikilink[] = [];
  for (const row of scanMarkdown(markdown)) {
    for (const segment of row) {
      if (segment.code) continue;
      for (const match of segment.text.matchAll(/(!?)\[\[([^\]\n]+)\]\]/g)) {
        const inner = match[2] ?? "";
        const [beforeAlias = "", ...aliasParts] = inner.split("|");
        const [target = "", ...headingParts] = beforeAlias.split("#");
        links.push({
          target: target.trim(),
          heading: headingParts.join("#").trim(),
          alias: aliasParts.join("|").trim(),
          embed: match[1] === "!",
          raw: match[0],
        });
      }
    }
  }
  return links;
}
