/** @jsxImportSource react */
import { isPlainNavigationClick } from "@smthrs/ui";
import { cn } from "@smthrs/ui-css";
import { type KeyboardEvent, useState } from "react";
import type { RepoViewLocation } from "./RepoView";
import { useInjectRepoViewCss } from "./styles";

/** A place in the repository a symbol is defined or used: its file, its 1-based line and that line's text. */
export interface SymbolsPaneLocation {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

/** One entry of a file's outline: its name, a short kind label, its 1-based line and how deep it nests. */
export interface SymbolsPaneOutlineItem {
  readonly name: string;
  readonly kind: string;
  readonly line: number;
  readonly depth: number;
}

/** The selected symbol. A list that is still loading is `undefined`. */
export interface SymbolsPaneSymbol {
  readonly name: string;
  readonly definitions: ReadonlyArray<SymbolsPaneLocation> | undefined;
  readonly references: ReadonlyArray<SymbolsPaneLocation> | undefined;
}

export type SymbolsPaneProps = {
  /** The file the pane is beside: the outline's rows open in it. */
  path: string;
  /** The selected symbol's definitions and references; absent, the pane shows the outline. */
  symbol?: SymbolsPaneSymbol | undefined;
  /** The file's outline; `undefined` while it loads. */
  outline?: ReadonlyArray<SymbolsPaneOutlineItem> | undefined;
  /** The URL of a location, so every row is a real link. */
  href: (location: RepoViewLocation) => string;
  /** A plain click or Enter on a row. */
  onOpen: (location: RepoViewLocation) => void;
  /** Close, or Escape inside the pane. */
  onClose: () => void;
  className?: string | undefined;
};

/** Locations grouped by file, in the order their files first appear. */
const byFile = (locations: ReadonlyArray<SymbolsPaneLocation>) => {
  const groups = new Map<string, Array<SymbolsPaneLocation>>();
  for (const location of locations) groups.set(location.path, [...(groups.get(location.path) ?? []), location]);
  return [...groups];
};

/** ↑ and ↓ move focus through the pane's rows. */
const moveFocus = (event: KeyboardEvent<HTMLElement>) => {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-slot='symbols-row']")];
  const at = rows.indexOf(event.target as HTMLElement);
  const next = rows[event.key === "ArrowDown" ? at + 1 : at - 1] ?? (at === -1 ? rows[0] : undefined);
  if (next === undefined) return;
  event.preventDefault();
  next.focus();
};

/**
 * The Symbols pane beside a file, as GitHub's code view has it: with a
 * symbol selected, its definitions and its references grouped by file, each
 * row a line number and that line's text; without one, the file's outline
 * with a filter. Every row is a link to the line at the same revision.
 * ↑ and ↓ move between rows, and Escape closes the pane.
 */
export function SymbolsPane({ path, symbol, outline, href, onOpen, onClose, className }: SymbolsPaneProps) {
  useInjectRepoViewCss();
  const [filter, setFilter] = useState("");
  const row = (location: RepoViewLocation, line: number, text: string, key: string) => (
    <a
      key={key}
      className="sui-symbols-row"
      data-slot="symbols-row"
      href={href(location)}
      onClick={(event) => {
        if (!isPlainNavigationClick(event)) return;
        event.preventDefault();
        onOpen(location);
      }}
    >
      <span className="sui-symbols-line">{line}</span>
      <code className="sui-symbols-text">{text}</code>
    </a>
  );
  const section = (title: string, locations: ReadonlyArray<SymbolsPaneLocation> | undefined) => (
    <section className="sui-symbols-section" aria-label={title}>
      <h3 className="sui-symbols-heading">
        {title}
        {locations === undefined || title === "Definition" ? null : <span>{locations.length}</span>}
      </h3>
      {byFile(locations ?? []).map(([file, places]) => (
        <div key={file} className="sui-symbols-file">
          <div className="sui-symbols-file-name">
            {file}
            <span>{places.length}</span>
          </div>
          {places.map((place, index) =>
            row({ kind: "blob", path: place.path, line: place.line }, place.line, place.text, `${place.path}:${place.line}:${index}`)
          )}
        </div>
      ))}
    </section>
  );
  const shown = (outline ?? []).filter((item) => item.name.toLowerCase().includes(filter.toLowerCase()));
  return (
    <aside
      className={cn("sui-symbols", className)}
      data-slot="symbols-pane"
      aria-label="Symbols"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
          return;
        }
        moveFocus(event);
      }}
    >
      <header className="sui-symbols-head">
        <strong className="sui-symbols-title">{symbol?.name ?? "Symbols"}</strong>
        <button type="button" className="sui-symbols-close" aria-label="Close" onClick={onClose}>✕</button>
      </header>
      {symbol === undefined ?
        (
          <>
            <input
              className="sui-symbols-filter"
              type="search"
              placeholder="Filter"
              aria-label="Filter symbols"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <nav className="sui-symbols-outline" aria-label="Outline">
              {shown.map((item, index) => (
                <a
                  key={`${item.name}:${item.line}:${index}`}
                  className="sui-symbols-row sui-symbols-outline-row"
                  data-slot="symbols-row"
                  style={{ paddingInlineStart: `${12 + item.depth * 14}px` }}
                  href={href({ kind: "blob", path, line: item.line })}
                  onClick={(event) => {
                    if (!isPlainNavigationClick(event)) return;
                    event.preventDefault();
                    onOpen({ kind: "blob", path, line: item.line });
                  }}
                >
                  <span className="sui-symbols-kind">{item.kind}</span>
                  <span className="sui-symbols-text">{item.name}</span>
                </a>
              ))}
            </nav>
          </>
        ) :
        (
          <>
            {section("Definition", symbol.definitions)}
            {section("References", symbol.references)}
          </>
        )}
    </aside>
  );
}
