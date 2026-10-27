/** @jsxImportSource react */
import { type ComponentProps, createContext, Fragment, memo, type MouseEvent, type ReactNode, useContext, useMemo } from "react";
import { markdownDocumentBody } from "./markdownDocumentBody";
import { CodeBlock } from "./CodeBlock";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../table";
import { cn } from "../cn";
import { safeHref } from "../internal/safeHref";
import { useInjectUiCss } from "../styles";

/**
 * Inline tokens, in match priority order: `code`, **bold**, *italic*, and
 * [links](href). Bold is matched before italic so `**x**` isn't eaten by the
 * single-asterisk rule; code is matched first so `*` inside a span stays
 * literal. Links start with `[`, so they never collide with the other rules.
 */
const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*|\[[^\]]+\]\([^)]+\))/g;
const LINK = /^\[([^\]]+)\]\(([^)]+)\)$/;
/**
 * Document mode also reads images, ahead of links: a linked image
 * `[![alt](src)](href)` (a README badge) and a bare `![alt](src)`.
 */
const DOCUMENT_INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*|\[!\[[^\]]*\]\([^)]*\)\]\([^)]+\)|!\[[^\]]*\]\([^)]*\)|\[[^\]]+\]\([^)]+\))/g;
const LINKED_IMAGE = /^\[!\[([^\]]*)\]\([^)]*\)\]\(([^)]+)\)$/;
const IMAGE = /^!\[([^\]]*)\]\([^)]*\)$/;
/** A whole line that is one image, `![alt](src)`: the image block a host may draw through `resolveImage`. */
const IMAGE_BLOCK = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;

/** Handler that maps an image source to its light and dark files, or `undefined` when it has none. */
export type MarkdownImageResolver = (src: string) => { readonly light: string; readonly dark: string } | undefined;

/** Handler invoked when a rendered link is activated. */
export type MarkdownLinkClick = (href: string, event: MouseEvent<HTMLAnchorElement>) => void;

/**
 * How the source is read. `chat`, the default, is what a model emits: a single
 * newline is a line break and HTML is shown as the text it is. `document` reads
 * a repository file the way GitHub renders it: HTML comments are dropped, a
 * `<pre>` keeps its spacing, other HTML tags render only their text (keeping
 * bold, italic, code, line breaks and scheme-safe links), and a single newline
 * inside a paragraph is a space. `>` lines are a blockquote, and one whose first
 * line is exactly `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` or
 * `[!CAUTION]` is a GitHub alert. An image renders as its alt text: no `<img>`
 * is created, so the source never makes the page fetch anything.
 */
export type MarkdownVariant = "chat" | "document";

/** The `baseUrl` a document's relative links resolve against; none leaves them as written. */
const MarkdownBase = createContext<string | undefined>(undefined);

/**
 * `href` resolved against `base` when it is relative (no scheme), so a page's
 * `/x.md` points at its own site rather than the host's. An absolute `href`,
 * or a `base` that isn't a URL, stays as it is.
 */
const resolveMarkdownHref = (href: string | undefined, base: string | undefined): string | undefined => {
  if (href === undefined || base === undefined || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return href;
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
};

function MarkdownLink({ href: raw, label, onLinkClick }: { href: string | undefined; label: ReactNode; onLinkClick?: MarkdownLinkClick }) {
  const href = resolveMarkdownHref(raw, useContext(MarkdownBase));
  return (
    <a
      className="sui-md-link"
      href={href}
      onClick={
        onLinkClick
          ? (event) => {
              event.preventDefault();
              if (href !== undefined) onLinkClick(href, event);
            }
          : undefined
      }
    >
      {label}
    </a>
  );
}

/** A link with a scheme-filtered href; an unsafe href leaves an anchor without one. */
const linkNode = (href: string | undefined, label: ReactNode, key: string, onLinkClick?: MarkdownLinkClick) => (
  <MarkdownLink key={key} href={href} label={label} {...(onLinkClick ? { onLinkClick } : {})} />
);

const keep = (text: string) => text;

/**
 * Everything renders through React children (never `innerHTML`), so model
 * output can't inject markup -- this lightweight renderer is XSS-safe by
 * construction, and link hrefs are additionally scheme-filtered. `text` maps
 * every run of prose (document mode decodes its HTML entities); code spans
 * stay verbatim. `document` adds images: an image is its alt text (nothing when
 * the alt is empty), and a linked image is a link labeled with that text.
 */
function renderInline(
  text: string,
  keyPrefix: string,
  onLinkClick?: MarkdownLinkClick,
  prose: (text: string) => string = keep,
  document = false,
): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const match of text.matchAll(document ? DOCUMENT_INLINE : INLINE)) {
    const idx = match.index ?? 0;
    if (idx > last) {
      out.push(prose(text.slice(last, idx)));
    }
    const token = match[0];
    const key = `${keyPrefix}.${i++}`;
    if (token.startsWith("`")) {
      out.push(
        <code className="sui-md-inline-code" key={key}>
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      out.push(<strong key={key}>{prose(token.slice(2, -2))}</strong>);
    } else if (document && LINKED_IMAGE.test(token)) {
      const image = LINKED_IMAGE.exec(token)!;
      const alt = prose(image[1]!);
      if (alt !== "") out.push(linkNode(safeHref(image[2]!), alt, key, onLinkClick));
    } else if (document && IMAGE.test(token)) {
      const alt = prose(IMAGE.exec(token)![1]!);
      if (alt !== "") out.push(alt);
    } else if (token.startsWith("[")) {
      const link = LINK.exec(token)!;
      out.push(linkNode(safeHref(link[2]!), prose(link[1]!), key, onLinkClick));
    } else {
      out.push(<em key={key}>{prose(token.slice(1, -1))}</em>);
    }
    last = idx + token.length;
  }
  if (last < text.length) {
    out.push(prose(text.slice(last)));
  }
  return out;
}

/*
 * Document mode's HTML: a repository README is written for GitHub, which
 * renders a small set of HTML. None of it reaches the page as markup. Tags are
 * read only to decide what their text looks like, and every node is built as a
 * React child, so no attribute (an `onclick`, a `style`) or element (a
 * `<script>`) the source names is ever created.
 */

/** One HTML tag, attributes quoted or bare (`<p align="center">`, `</p>`, `<br/>`). */
const TAG = /<\/?[a-z][\w:-]*(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gi;
/** A Markdown autolink, `<https://smithers.sh>`, which is a link and not a tag. */
const AUTOLINK = /<(?:https?|mailto):[^\s<>]*>/;
/** An HTML comment, closed or running to the end of the source. */
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;

/** Tags with no content of their own. */
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
/** Tags that start a new paragraph; `h1`-`h6` make it a heading. */
const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "center", "dd", "details", "dialog", "div", "dl", "dt", "fieldset",
  "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav",
  "ol", "p", "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
  copy: "©", reg: "®", trade: "™", hellip: "…", ndash: "–", mdash: "—",
};

/** Decode HTML character references; an unknown name stays as written. */
const decodeEntities = (text: string): string =>
  text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (!name.startsWith("#")) return ENTITIES[name.toLowerCase()] ?? entity;
    const point = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : "\ufffd";
  });

type Tag = { readonly name: string; readonly closing: boolean; readonly empty: boolean; readonly attrs: Readonly<Record<string, string>> };

const parseTag = (token: string): Tag => {
  const name = /^<\/?([\w:-]+)/.exec(token)![1]!.toLowerCase();
  const attrs: Record<string, string> = {};
  for (const attr of token.slice(name.length + 1).matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
    attrs[attr[1]!.toLowerCase()] = decodeEntities(attr[2] ?? attr[3] ?? attr[4] ?? "");
  }
  return { name, closing: token.startsWith("</"), empty: VOID_TAGS.has(name) || /\/\s*>$/.test(token), attrs };
};

/** `align="center"` is the one presentational attribute a README relies on. */
const centered = (attrs: Readonly<Record<string, string>>) => attrs.align?.toLowerCase() === "center";

/** One paragraph (or heading) an HTML flow produced. */
type FlowBlock = { readonly level?: number; readonly center: boolean; readonly nodes: ReactNode[] };
type Frame = { readonly tag: Tag; readonly children: ReactNode[] };

const isBlank = (nodes: ReadonlyArray<ReactNode>) => nodes.every((node) => typeof node === "string" && node.trim() === "");

/** Trim the whitespace an HTML source leaves at a paragraph's edges. */
const trimEdges = (nodes: ReactNode[]): ReactNode[] => {
  const out = [...nodes];
  const first = out[0];
  if (typeof first === "string") out[0] = first.trimStart();
  const last = out[out.length - 1];
  if (typeof last === "string") out[out.length - 1] = last.trimEnd();
  return out;
};

/**
 * Read text that may carry HTML into paragraphs. `markdown` says whether the
 * text between tags is Markdown (a paragraph that uses inline HTML) or plain
 * text (an HTML block, which GitHub does not read as Markdown).
 *
 * Bold, italic, code and safe links keep their meaning; `<br>` breaks the line;
 * `<img>` leaves its alt text; a block tag (`<p>`, `<div>`, `<h1>`) starts a new
 * paragraph; every other tag is dropped and its text kept.
 */
function renderFlow(source: string, keyPrefix: string, onLinkClick: MarkdownLinkClick | undefined, markdown: boolean): FlowBlock[] {
  const blocks: FlowBlock[] = [];
  const open: Tag[] = [];
  const stack: Frame[] = [];
  let root: ReactNode[] = [];
  let n = 0;
  const key = () => `${keyPrefix}.${n++}`;
  const top = () => stack[stack.length - 1]?.children ?? root;

  const materialize = ({ tag, children }: Frame): ReactNode => {
    switch (tag.name) {
      case "strong":
      case "b":
        return <strong key={key()}>{children}</strong>;
      case "em":
      case "i":
        return <em key={key()}>{children}</em>;
      case "code":
        return <code className="sui-md-inline-code" key={key()}>{children}</code>;
      default: {
        // `a`: a link only when its URL passes the renderer's link rules; otherwise its text.
        const href = tag.attrs.href === undefined ? undefined : safeHref(tag.attrs.href);
        return href === undefined ? <Fragment key={key()}>{children}</Fragment> : linkNode(href, children, key(), onLinkClick);
      }
    }
  };
  const closeTo = (depth: number) => {
    while (stack.length > depth) {
      const frame = stack.pop()!;
      top().push(materialize(frame));
    }
  };
  const flush = () => {
    closeTo(0);
    if (!isBlank(root)) {
      const heading = [...open].reverse().find((tag) => /^h[1-6]$/.test(tag.name));
      blocks.push({ level: heading ? Number(heading.name[1]) : undefined, center: open.some((tag) => centered(tag.attrs)), nodes: trimEdges(root) });
    }
    root = [];
  };
  const text = (run: string) => {
    if (run === "") return;
    const spaced = run.replace(/[ \t\r\n]+/g, " ");
    if (markdown && !stack.some((frame) => frame.tag.name === "code")) top().push(...renderInline(spaced, key(), onLinkClick, decodeEntities, true));
    else top().push(decodeEntities(spaced));
  };
  const tag = (token: string) => {
    const parsed = parseTag(token);
    if (BLOCK_TAGS.has(parsed.name)) {
      flush();
      if (parsed.closing) {
        const at = open.map((tag) => tag.name).lastIndexOf(parsed.name);
        if (at !== -1) open.length = at;
      } else if (!parsed.empty) open.push(parsed);
      return;
    }
    if (parsed.closing) {
      const at = stack.map((frame) => frame.tag.name).lastIndexOf(parsed.name);
      if (at !== -1) closeTo(at);
      return;
    }
    if (parsed.name === "br") top().push(<br key={key()} />);
    else if (parsed.name === "img" && parsed.attrs.alt) top().push(parsed.attrs.alt);
    else if (!parsed.empty && ["strong", "b", "em", "i", "code", "a"].includes(parsed.name)) stack.push({ tag: parsed, children: [] });
  };

  // Code spans stay whole so a tag inside one is text; an autolink is a link; comments are dropped.
  const tokens = new RegExp(`${markdown ? `\`[^\`]+\`|${AUTOLINK.source}|` : ""}${COMMENT.source}|${TAG.source}`, "gi");
  let last = 0;
  for (const match of source.matchAll(tokens)) {
    const token = match[0];
    if (token.startsWith("`")) continue;
    const at = match.index ?? 0;
    text(source.slice(last, at));
    last = at + token.length;
    if (new RegExp(`^${AUTOLINK.source}$`, "i").test(token)) {
      const url = token.slice(1, -1);
      top().push(linkNode(safeHref(url), url, key(), onLinkClick));
    } else if (!token.startsWith("<!--")) tag(token);
  }
  text(source.slice(last));
  flush();
  return blocks;
}

/** A document's inline content (a heading, list item or table cell): its flow's paragraphs, side by side. */
const flowInline = (text: string, keyPrefix: string, onLinkClick?: MarkdownLinkClick): ReactNode[] =>
  renderFlow(text, keyPrefix, onLinkClick, true).flatMap((block, index) => (index > 0 ? [" ", ...block.nodes] : block.nodes));

/** Render a flow's paragraphs, a heading where an `h1`-`h6` asked for one. */
const flowBlocks = (blocks: ReadonlyArray<FlowBlock>, key: number): ReactNode => (
  <Fragment key={key}>
    {blocks.map((block, index) => {
      const style = block.center ? { textAlign: "center" as const } : undefined;
      return block.level === undefined ? (
        <p className="sui-md-p" key={index} style={style}>
          {block.nodes}
        </p>
      ) : (
        <div className={`sui-md-heading sui-md-h${block.level}`} role="heading" aria-level={block.level} key={index} style={style}>
          {block.nodes}
        </div>
      );
    })}
  </Fragment>
);

const isBullet = (line: string) => /^\s*[-*]\s+/.test(line);
const isOrdered = (line: string) => /^\s*\d+\.\s+/.test(line);
const isFence = (line: string) => line.trimStart().startsWith("```");
const isHeading = (line: string) => /^#{1,6}\s+/.test(line);

/*
 * GitHub-flavored tables.
 *
 * A table is one of the shapes a model reaches for most — "which repos, how
 * many issues" is a table — and without a rule here every `|` and every
 * `---|---` lands on screen as literal text inside one paragraph.
 * The shape is a header row, a delimiter row
 * whose column count matches it, then rows until a line that is not a row.
 */

/** A line that could be a table row: it has a pipe and is not a fence. */
const isRow = (line: string) => line.includes("|") && !isFence(line);

/** `---`, `:--`, `--:`, or `:-:`, which is the delimiter row's whole grammar. */
const isDelimiter = (cell: string) => /^:?-+:?$/.test(cell.trim());

/** Split one row into cells, dropping the optional leading and trailing pipes. */
const rowCells = (line: string): string[] => {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
};

/** The per-column alignment the delimiter row declares. */
type Alignment = "left" | "center" | "right";

const alignmentOf = (cell: string): Alignment => {
  const text = cell.trim();
  if (text.startsWith(":") && text.endsWith(":")) return "center";
  if (text.endsWith(":")) return "right";
  return "left";
};

/**
 * Whether a table starts at `index`, and how wide it is.
 *
 * A header row alone is a paragraph; it is the matching delimiter row that
 * makes it a table, which is exactly the rule that keeps a sentence containing
 * a pipe from becoming one.
 */
const tableAt = (lines: ReadonlyArray<string>, index: number): number | undefined => {
  const header = lines[index]
  const delimiter = lines[index + 1]
  if (header === undefined || delimiter === undefined) return undefined;
  if (!isRow(header) || !isRow(delimiter)) return undefined;
  const cells = rowCells(delimiter);
  if (cells.length === 0 || !cells.every(isDelimiter)) return undefined;
  return rowCells(header).length === cells.length ? cells.length : undefined;
};

/** A line that is exactly one image: an image block, which `resolveImage` may draw. */
const isImageLine = (line: string) => IMAGE_BLOCK.test(line.trim());

/** The block kinds the scanner recognizes; `comment`, `pre`, `html` and `blockquote` exist only in document mode. */
type BlockKind = "fence" | "table" | "heading" | "image" | "bullet" | "ordered" | "paragraph" | "comment" | "pre" | "html" | "blockquote";

/*
 * Document mode's blockquotes, after CommonMark: a `>` line opens one, and it
 * runs over the `>` lines that follow and over lazy lines, unquoted text that
 * continues the quote's last paragraph. Its content is the lines with one `>`
 * removed, read again as a document, so quotes nest.
 */
const isQuote = (line: string) => /^ {0,3}>/.test(line);
const unquote = (line: string) => line.replace(/^ {0,3}> ?/, "");
/** A quoted line's innermost content, every level of `>` removed. */
const innermost = (line: string) => line.replace(/^(?: {0,3}> ?)+/, "");

/** The five GitHub alerts, by the marker that must be a quote's whole first line. */
const ALERTS: ReadonlyMap<string, { readonly kind: string; readonly title: string; readonly icon: ReactNode }> = new Map([
  ["[!NOTE]", { kind: "note", title: "Note", icon: [<circle key="c" cx="12" cy="12" r="9" />, <path key="p" d="M12 11v6M12 7h.01" />] }],
  ["[!TIP]", { kind: "tip", title: "Tip", icon: [<path key="p" d="M9 18h6M10 21h4M8 13a6 6 0 1 1 8 0c-1 1-1 2-1 3H9c0-1 0-2-1-3Z" />] }],
  [
    "[!IMPORTANT]",
    {
      kind: "important",
      title: "Important",
      icon: [
        <path key="p" d="M5 3h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-8l-6 4v-4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />,
        <path key="q" d="M12 7v4M12 14h.01" />,
      ],
    },
  ],
  ["[!WARNING]", { kind: "warning", title: "Warning", icon: [<path key="p" d="m12 3 10 18H2L12 3Z" />, <path key="q" d="M12 9v5M12 17h.01" />] }],
  ["[!CAUTION]", { kind: "caution", title: "Caution", icon: [<path key="p" d="m8 2-6 6v8l6 6h8l6-6V8l-6-6H8Z" />, <path key="q" d="M12 7v6M12 17h.01" />] }],
]);

/*
 * Document mode's HTML blocks, after CommonMark: a comment runs to its `-->`,
 * a `<pre>` to its `</pre>`, and a line that opens with a block tag (or is one
 * whole tag) to the next blank line. Only the first two, a block tag and a
 * blockquote may interrupt a paragraph.
 */
const isCommentStart = (line: string) => /^ {0,3}<!--/.test(line);
const isPreStart = (line: string) => /^ {0,3}<pre(?=[\s>]|$)/i.test(line);
const isBlockTagStart = (line: string) => {
  const name = /^ {0,3}<\/?([a-z][\w-]*)(?=[\s/>]|$)/i.exec(line)?.[1];
  return name !== undefined && BLOCK_TAGS.has(name.toLowerCase());
};
const isWholeTagLine = (line: string) => {
  const trimmed = line.trim();
  return trimmed.startsWith("<") && new RegExp(`^${TAG.source}$`, "i").test(trimmed);
};
const interruptsParagraph = (line: string) => isCommentStart(line) || isPreStart(line) || isBlockTagStart(line) || isQuote(line);

/**
 * One block of source, tagged with the kind that claimed it. `text` is the
 * exact source slice, which is what the completed-block cache is keyed by.
 */
type BlockSpan = { readonly kind: BlockKind; readonly lines: ReadonlyArray<string>; readonly text: string };

/**
 * The one block-boundary grammar: rendering dispatches on these spans and the
 * completed-block cache is keyed by their text, so a boundary rule is stated
 * once and a streaming block boundary cannot disagree with what is drawn.
 *
 * Priority is fence, table, heading, image, bullet, ordered, paragraph (document mode
 * adds blockquote, comment, `<pre>` and HTML right after fence). A table wins
 * over a list because the delimiter row is the stronger signal: `- a | b` above
 * `--- | ---` is a header row, not a bullet.
 *
 * The final span may still grow while content streams; every earlier span is
 * stable, which is what makes it safe to cache.
 */
function scanBlocks(content: string, variant: MarkdownVariant = "chat"): BlockSpan[] {
  const lines = (variant === "document" ? markdownDocumentBody(content) : content).split("\n");
  const spans: BlockSpan[] = [];
  const document = variant === "document";
  let i = 0;

  /** Advance past the line that ends a block, or off the end of the source. */
  const through = (ends: (line: string, first: boolean) => boolean) => {
    const first = i;
    while (i < lines.length && !ends(lines[i]!, i === first)) i += 1;
    i = Math.min(i + 1, lines.length);
  };

  while (i < lines.length) {
    if (lines[i]!.trim() === "") {
      i += 1;
      continue;
    }

    const start = i;
    let kind: BlockKind;
    if (isFence(lines[i]!)) {
      kind = "fence";
      i += 1;
      while (i < lines.length && !isFence(lines[i]!)) i += 1;
      if (i < lines.length) i += 1; // consume the closing fence (or run off the end)
    } else if (document && isQuote(lines[i]!)) {
      kind = "blockquote";
      // `last` is the quote's latest content line; a lazy line may follow only a paragraph line.
      let last = "";
      let fenced = false;
      while (i < lines.length) {
        const line = lines[i]!;
        const quoted = isQuote(line);
        if (!quoted) {
          const startsBlock = isFence(line) || isHeading(line) || isBullet(line) || isOrdered(line) || interruptsParagraph(line) || tableAt(lines, i) !== undefined;
          if (fenced || last.trim() === "" || isHeading(last) || line.trim() === "" || startsBlock) break;
        }
        last = quoted ? innermost(line) : line;
        if (quoted && isFence(last)) fenced = !fenced;
        i += 1;
      }
    } else if (document && isCommentStart(lines[i]!)) {
      kind = "comment";
      through((line, first) => (first ? line.slice(line.indexOf("<!--") + 4) : line).includes("-->"));
    } else if (document && isPreStart(lines[i]!)) {
      kind = "pre";
      through((line) => /<\/pre>/i.test(line));
    } else if (document && (isBlockTagStart(lines[i]!) || isWholeTagLine(lines[i]!))) {
      kind = "html";
      while (i < lines.length && lines[i]!.trim() !== "") i += 1;
    } else if (tableAt(lines, i) !== undefined) {
      kind = "table";
      i += 2;
      while (i < lines.length && isRow(lines[i]!) && lines[i]!.trim() !== "") i += 1;
    } else if (isHeading(lines[i]!)) {
      kind = "heading";
      i += 1;
    } else if (isImageLine(lines[i]!)) {
      kind = "image";
      i += 1;
    } else if (isBullet(lines[i]!)) {
      kind = "bullet";
      while (i < lines.length && isBullet(lines[i]!)) i += 1;
    } else if (isOrdered(lines[i]!)) {
      kind = "ordered";
      while (i < lines.length && isOrdered(lines[i]!)) i += 1;
    } else {
      kind = "paragraph";
      while (
        i < lines.length &&
        lines[i]!.trim() !== "" &&
        !isFence(lines[i]!) &&
        !isHeading(lines[i]!) &&
        !isImageLine(lines[i]!) &&
        !isBullet(lines[i]!) &&
        !isOrdered(lines[i]!) &&
        tableAt(lines, i) === undefined &&
        !(document && interruptsParagraph(lines[i]!))
      ) {
        i += 1;
      }
    }

    const block = lines.slice(start, i);
    spans.push({ kind, lines: block, text: block.join("\n") });
  }

  return spans;
}

/** A `<pre>` block's text: tags dropped (`<br>` a newline), entities decoded, spacing kept. */
const preText = (body: string) =>
  decodeEntities(body.replace(COMMENT, "").replace(/<br\s*\/?>/gi, "\n").replace(TAG, ""))
    .replace(/^\r?\n/, "")
    .replace(/\r?\n$/, "");

/** A document paragraph's source: lines joined by spaces, a trailing two spaces or `\` a hard break. */
const documentParagraph = (lines: ReadonlyArray<string>) =>
  lines.map((line, index) => (index < lines.length - 1 ? line.replace(/(?: {2,}|\\)$/, "<br>") : line).trim()).join(" ");

/**
 * Render one scanned span, dispatching on the kind the scanner gave it.
 * `quoted` says the span sits inside a blockquote, where GitHub draws no alert.
 */
function renderSpan(
  span: BlockSpan,
  key: number,
  onLinkClick?: MarkdownLinkClick,
  variant: MarkdownVariant = "chat",
  quoted = false,
  resolveImage?: MarkdownImageResolver,
): ReactNode {
  const lines = span.lines;
  const inline =
    variant === "document"
      ? (text: string, keyPrefix: string) => flowInline(text, keyPrefix, onLinkClick)
      : (text: string, keyPrefix: string) => renderInline(text, keyPrefix, onLinkClick);

  switch (span.kind) {
    case "comment":
      return null;

    case "blockquote": {
      const content = lines.map((line) => (isQuote(line) ? unquote(line) : line));
      const alert = quoted ? undefined : ALERTS.get(content[0]!.trim());
      const body = scanBlocks((alert ? content.slice(1) : content).join("\n"), "document").map((child, index) =>
        renderSpan(child, index, onLinkClick, "document", true),
      );
      if (alert === undefined) {
        return (
          <blockquote className="sui-md-blockquote" key={key}>
            {body}
          </blockquote>
        );
      }
      return (
        <aside className="sui-md-alert" data-kind={alert.kind} key={key}>
          <strong className="sui-md-alert-label" key="label">
            <svg
              key="icon"
              width={16}
              height={16}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {alert.icon}
            </svg>
            {alert.title}
          </strong>
          {body}
        </aside>
      );
    }

    case "pre": {
      const open = new RegExp(TAG.source, "i").exec(span.text)!;
      const body = span.text.slice(open.index + open[0].length).replace(/<\/pre>[\s\S]*$/i, "");
      return (
        <pre className="sui-md-pre" data-align={centered(parseTag(open[0]).attrs) ? "center" : undefined} key={key}>
          <code>{preText(body)}</code>
        </pre>
      );
    }

    case "html":
      return flowBlocks(renderFlow(span.text, `html${key}`, onLinkClick, false), key);

    case "fence": {
      const info = lines[0]!.trimStart().slice(3).trim();
      const language = info ? info.split(/\s+/, 1)[0]!.toLowerCase() : undefined;
      const body = lines.slice(1);
      // An unterminated fence has no closing line to drop.
      if (body.length > 0 && isFence(body[body.length - 1]!)) body.pop();
      return <CodeBlock code={body.join("\n")} language={language} key={key} />;
    }

    case "table": {
      const columns = rowCells(lines[1]!).length;
      const alignments = rowCells(lines[1]!).map(alignmentOf);
      const header = rowCells(lines[0]!);
      const rows = lines.slice(2).map(rowCells);
      return (
        <Table className="sui-md-table" key={key}>
          <TableHeader>
            <TableRow>
              {header.map((cell, column) => (
                <TableHead key={column} style={{ textAlign: alignments[column] ?? "left" }}>
                  {inline(cell, `th${key}.${column}`)}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((cells, row) => (
              <TableRow key={row}>
                {/*
                  A ragged row is the source's, not a reason to drop it: every
                  declared column is rendered and a missing cell is empty.
                */}
                {Array.from({ length: columns }, (_unused, column) => (
                  <TableCell key={column} style={{ textAlign: alignments[column] ?? "left" }}>
                    {inline(cells[column] ?? "", `td${key}.${row}.${column}`)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      );
    }

    case "heading": {
      const heading = /^(#{1,6})\s+(.*)$/.exec(lines[0]!)!;
      const level = heading[1]!.length;
      return (
        <div className={`sui-md-heading sui-md-h${level}`} role="heading" aria-level={level} key={key}>
          {inline(heading[2]!, `h${key}`)}
        </div>
      );
    }

    case "bullet":
      return (
        <ul className="sui-md-list" key={key}>
          {lines.map((line, item) => (
            <li key={item}>{inline(line.replace(/^\s*[-*]\s+/, ""), `ul${key}.${item}`)}</li>
          ))}
        </ul>
      );

    case "ordered":
      return (
        <ol className="sui-md-list" key={key}>
          {lines.map((line, item) => (
            <li key={item}>{inline(line.replace(/^\s*\d+\.\s+/, ""), `ol${key}.${item}`)}</li>
          ))}
        </ol>
      );

    case "image": {
      const image = IMAGE_BLOCK.exec(lines[0]!.trim())!;
      // Only the resolver's files reach an <img>; a source from the text never does.
      const files = resolveImage?.(image[2]!);
      if (files === undefined) {
        // A host that draws images but has none for this source shows the alt text, never a link to the file;
        // without a resolver the line reads exactly as it would as a paragraph in this variant.
        if (resolveImage === undefined) return renderSpan({ ...span, kind: "paragraph" }, key, onLinkClick, variant, quoted);
        return (
          <p className="sui-md-p" key={key}>
            {image[1]!}
          </p>
        );
      }
      return (
        <figure className="sui-md-figure" key={key}>
          {(["light", "dark"] as const).map((theme) => (
            <img
              className="sui-md-image"
              data-variant={theme}
              key={theme}
              src={files[theme]}
              alt={image[1]!}
              width={1440}
              height={900}
              loading="lazy"
              decoding="async"
            />
          ))}
        </figure>
      );
    }

    case "paragraph":
      // A document joins its lines (GitHub's soft break); chat keeps each line on its own.
      if (variant === "document") return flowBlocks(renderFlow(documentParagraph(lines), `p${key}`, onLinkClick, true), key);
      return (
        <p className="sui-md-p" key={key}>
          {lines.map((text, idx) => (
            <Fragment key={idx}>
              {idx > 0 ? <br /> : null}
              {renderInline(text, `p${key}.${idx}`, onLinkClick)}
            </Fragment>
          ))}
        </p>
      );
  }
}

/** Parse the source into block-level React nodes. */
function renderBlocks(
  content: string,
  onLinkClick?: MarkdownLinkClick,
  variant: MarkdownVariant = "chat",
  resolveImage?: MarkdownImageResolver,
): ReactNode[] {
  return scanBlocks(content, variant).map((span, index) => renderSpan(span, index, onLinkClick, variant, false, resolveImage));
}

/** @internal Exposed so parser reuse can be verified without mocking Markdown output. */
export const markdownBlockParser = { render: renderBlocks, scan: scanBlocks };

export type MarkdownProps = Omit<ComponentProps<"div">, "children" | "onClick"> & {
  /** The Markdown source string to render. */
  content: string;
  /**
   * Intercept link activation instead of navigating. Receives the (scheme-safe)
   * href and the click event, with `preventDefault()` already called.
   */
  onLinkClick?: MarkdownLinkClick;
  /** `chat` (default) for model output; `document` for a repository file such as a README. */
  variant?: MarkdownVariant;
  /**
   * Draw a line that is exactly `![alt](src)` as the light and dark files this
   * returns, one shown per `html[data-theme]`. When it returns `undefined` the
   * line shows its alt text; without it the line renders as it would as a paragraph.
   */
  resolveImage?: MarkdownImageResolver;
  /**
   * The absolute URL the source came from: relative links (`/x.md`, `./y.md`,
   * `#part`) resolve against it, so they open where the document lives, not
   * on the host. Without it they stay as written.
   */
  baseUrl?: string;
};

/**
 * A small, dependency-free Markdown renderer covering what a chat model
 * actually emits: fenced code blocks, headings, ordered/unordered lists,
 * GitHub-flavored tables, inline code, bold, italics, and links. Anything else
 * falls through as plain paragraphs. `variant="document"` reads a repository
 * file instead (see {@link MarkdownVariant}).
 *
 * Wrapped in `React.memo`, with completed blocks cached by source so streaming
 * updates only re-parse the trailing block.
 */
function MarkdownImpl({ content, onLinkClick, variant = "chat", resolveImage, baseUrl, className, ...props }: MarkdownProps) {
  useInjectUiCss();
  const completedBlocks = useMemo(() => new Map<string, ReactNode[]>(), [onLinkClick, variant, resolveImage]);
  const spans = scanBlocks(content, variant);
  const live = new Set<string>();
  const rendered = spans.map((span, index) => {
    if (index === spans.length - 1) return markdownBlockParser.render(span.text, onLinkClick, variant, resolveImage);

    live.add(span.text);
    let block = completedBlocks.get(span.text);
    if (!block) {
      block = markdownBlockParser.render(span.text, onLinkClick, variant, resolveImage);
      completedBlocks.set(span.text, block);
    }
    return block;
  });
  /*
   * Keep only what this document still shows. Content that is replaced rather
   * than appended -- a changing preview on one long-lived instance -- would
   * otherwise retain the source and node tree of every version it ever drew.
   */
  for (const source of completedBlocks.keys()) {
    if (!live.has(source)) completedBlocks.delete(source);
  }

  return (
    <MarkdownBase.Provider value={baseUrl}>
      <div data-slot="markdown" className={cn("sui-md", className)} {...props}>
        {rendered}
      </div>
    </MarkdownBase.Provider>
  );
}

export const Markdown = memo(MarkdownImpl);
