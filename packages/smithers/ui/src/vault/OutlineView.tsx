/** @jsxImportSource react */
import { useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { cn } from "../cn";
import { stepFence, type Fence } from "./fence";
import type { VaultRowProps } from "./types";
import { useVaultCss } from "./useVaultCss";

/** One heading in a markdown document, 1-based line numbered. */
export type OutlineHeading = {
  /** ATX level, 1 (h1) through 6 (h6). */
  depth: number;
  /** Heading text with any trailing `#`s stripped. */
  text: string;
  /** 1-based source line, for scroll-to-heading. */
  line: number;
};

/**
 * Parse markdown ATX headings into an outline. Fence-safe: `#` lines inside
 * fenced code blocks are not headings. Fence state comes from the shared
 * {@link stepFence} tracker, so a ``` ``` ``` example inside a ```` ```` ````
 * block no longer ends it and turns the code inside into headings.
 */
export function parseOutline(markdown: string): OutlineHeading[] {
  const headings: OutlineHeading[] = [];
  let fence: Fence | null = null;
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const step = stepFence(line, fence);
    fence = step.fence;
    if (step.fenced) continue;
    const match = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (match) {
      headings.push({ depth: match[1]!.length, text: match[2]!, line: i + 1 });
    }
  }
  return headings;
}

export type OutlineViewProps = {
  /** Markdown source to outline. */
  markdown: string;
  /** Click handler receiving the heading's 1-based source line. */
  onHeadingClick?: (line: number) => void;
  /**
   * Extra attributes for each heading row — the host's own binding
   * (`data-flow`, a test id, a title). Anything it sets wins over this
   * component's attribute of the same name, except the roving `tabIndex` and
   * the ref the tree's arrow keys need to move focus.
   */
  headingProps?: (heading: OutlineHeading) => VaultRowProps;
  className?: string;
  style?: CSSProperties;
  /** Copy shown when the document has no headings. */
  emptyLabel?: string;
};

/** The Obsidian outline pane: an indented, clickable heading tree. */
export function OutlineView({
  markdown,
  onHeadingClick,
  headingProps,
  className,
  style,
  emptyLabel = "No headings",
}: OutlineViewProps) {
  useVaultCss();
  const headings = parseOutline(markdown);
  // Roving tabindex: one tab stop into the tree, then arrows move between
  // items (Enter/Space activation is native to the <button> treeitems).
  // Headings are not collapsible, so Left/Right have no collapse/expand to
  // perform and pass through untouched.
  const [activeIndex, setActiveIndex] = useState(0);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const current = headings.length === 0 ? 0 : Math.min(activeIndex, headings.length - 1);

  function onKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (headings.length === 0) return;
    let next: number | null = null;
    if (event.key === "ArrowDown") next = (current + 1) % headings.length;
    else if (event.key === "ArrowUp") next = (current - 1 + headings.length) % headings.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = headings.length - 1;
    else return;
    event.preventDefault();
    setActiveIndex(next);
    itemRefs.current[next]?.focus();
  }

  return (
    <div
      data-slot="vault-outline"
      role="tree"
      aria-label="Document outline"
      className={cn("sui-vault-outline", className)}
      style={style}
      onKeyDown={onKeyDown}
    >
      {headings.length === 0 ? <p className="sui-vault-outline-empty">{emptyLabel}</p> : null}
      {headings.map((heading, index) => (
        <button
          key={`${heading.line}:${heading.text}`}
          ref={(el) => {
            itemRefs.current[index] = el;
          }}
          type="button"
          role="treeitem"
          aria-level={heading.depth}
          data-depth={heading.depth}
          className="sui-vault-outline-item"
          style={{ paddingLeft: 8 + (heading.depth - 1) * 14 }}
          onFocus={() => setActiveIndex(index)}
          onClick={() => onHeadingClick?.(heading.line)}
          {...headingProps?.(heading)}
          tabIndex={index === current ? 0 : -1}
        >
          {heading.text}
        </button>
      ))}
    </div>
  );
}
