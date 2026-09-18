/** @jsxImportSource react */
import { type ComponentProps, Fragment, memo, type MouseEvent, type ReactNode, useMemo } from "react";
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

/** Handler invoked when a rendered link is activated. */
export type MarkdownLinkClick = (href: string, event: MouseEvent<HTMLAnchorElement>) => void;

/**
 * Everything renders through React children (never `innerHTML`), so model
 * output can't inject markup -- this lightweight renderer is XSS-safe by
 * construction, and link hrefs are additionally scheme-filtered.
 */
function renderInline(text: string, keyPrefix: string, onLinkClick?: MarkdownLinkClick): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const match of text.matchAll(INLINE)) {
    const idx = match.index ?? 0;
    if (idx > last) {
      out.push(text.slice(last, idx));
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
      out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("[")) {
      const link = LINK.exec(token)!;
      const label = link[1]!;
      const href = safeHref(link[2]!);
      out.push(
        <a
          className="sui-md-link"
          key={key}
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
        </a>,
      );
    } else {
      out.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    last = idx + token.length;
  }
  if (last < text.length) {
    out.push(text.slice(last));
  }
  return out;
}

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

/** The block kinds the scanner recognizes. */
type BlockKind = "fence" | "table" | "heading" | "bullet" | "ordered" | "paragraph";

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
 * Priority is fence, table, heading, bullet, ordered, paragraph. A table wins
 * over a list because the delimiter row is the stronger signal: `- a | b` above
 * `--- | ---` is a header row, not a bullet.
 *
 * The final span may still grow while content streams; every earlier span is
 * stable, which is what makes it safe to cache.
 */
function scanBlocks(content: string): BlockSpan[] {
  const lines = content.split("\n");
  const spans: BlockSpan[] = [];
  let i = 0;

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
    } else if (tableAt(lines, i) !== undefined) {
      kind = "table";
      i += 2;
      while (i < lines.length && isRow(lines[i]!) && lines[i]!.trim() !== "") i += 1;
    } else if (isHeading(lines[i]!)) {
      kind = "heading";
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
        !isBullet(lines[i]!) &&
        !isOrdered(lines[i]!) &&
        tableAt(lines, i) === undefined
      ) {
        i += 1;
      }
    }

    const block = lines.slice(start, i);
    spans.push({ kind, lines: block, text: block.join("\n") });
  }

  return spans;
}

/** Render one scanned span, dispatching on the kind the scanner gave it. */
function renderSpan(span: BlockSpan, key: number, onLinkClick?: MarkdownLinkClick): ReactNode {
  const lines = span.lines;

  switch (span.kind) {
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
                  {renderInline(cell, `th${key}.${column}`, onLinkClick)}
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
                    {renderInline(cells[column] ?? "", `td${key}.${row}.${column}`, onLinkClick)}
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
        <div className={`sui-md-heading sui-md-h${level}`} key={key}>
          {renderInline(heading[2]!, `h${key}`, onLinkClick)}
        </div>
      );
    }

    case "bullet":
      return (
        <ul className="sui-md-list" key={key}>
          {lines.map((line, item) => (
            <li key={item}>{renderInline(line.replace(/^\s*[-*]\s+/, ""), `ul${key}.${item}`, onLinkClick)}</li>
          ))}
        </ul>
      );

    case "ordered":
      return (
        <ol className="sui-md-list" key={key}>
          {lines.map((line, item) => (
            <li key={item}>{renderInline(line.replace(/^\s*\d+\.\s+/, ""), `ol${key}.${item}`, onLinkClick)}</li>
          ))}
        </ol>
      );

    case "paragraph":
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
function renderBlocks(content: string, onLinkClick?: MarkdownLinkClick): ReactNode[] {
  return scanBlocks(content).map((span, index) => renderSpan(span, index, onLinkClick));
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
};

/**
 * A small, dependency-free Markdown renderer covering what a chat model
 * actually emits: fenced code blocks, headings, ordered/unordered lists,
 * GitHub-flavored tables, inline code, bold, italics, and links. Anything else
 * falls through as plain paragraphs.
 *
 * Wrapped in `React.memo`, with completed blocks cached by source so streaming
 * updates only re-parse the trailing block.
 */
function MarkdownImpl({ content, onLinkClick, className, ...props }: MarkdownProps) {
  useInjectUiCss();
  const completedBlocks = useMemo(() => new Map<string, ReactNode[]>(), [onLinkClick]);
  const spans = scanBlocks(content);
  const live = new Set<string>();
  const rendered = spans.map((span, index) => {
    if (index === spans.length - 1) return markdownBlockParser.render(span.text, onLinkClick);

    live.add(span.text);
    let block = completedBlocks.get(span.text);
    if (!block) {
      block = markdownBlockParser.render(span.text, onLinkClick);
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
    <div data-slot="markdown" className={cn("sui-md", className)} {...props}>
      {rendered}
    </div>
  );
}

export const Markdown = memo(MarkdownImpl);
