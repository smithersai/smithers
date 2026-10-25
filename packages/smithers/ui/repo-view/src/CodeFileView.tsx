/** @jsxImportSource react */
import { getFiletypeFromFileName, type FileOptions, type LineAnnotation } from "@pierre/diffs";
import { File, WorkerPoolContext, useStableCallback } from "@pierre/diffs/react";
import { cn, type ResolvedPalette, tokens as t, useResolvedPalette, useResolvedTheme } from "@smthrs/ui";
import { type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, useId, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import { diffsThemeForMode, type PierreDiffMode } from "./PierreDiffView";
import { useInjectRepoViewCss } from "./styles";
import { type CodeSymbol, CURSOR_KEYS, type CursorKey, isSymbolText, moveCursor } from "./symbols";
import { registerVibe } from "./vibe";
import { codeViewWorkerPool, currentCodeViewPool, subscribeCodeViewPool } from "./workerPool";

registerVibe();

/**
 * CodeFileView renders ONE repository file, syntax highlighted, through
 * `@pierre/diffs` `File` (Shiki underneath). It is the read-only file surface
 * the diff view already runs on, so files and diffs share one engine, one
 * theme mapping (`diffsThemeForMode`, fourteen Shiki ids for the nine
 * palettes) and one grammar registry. It lives in `@smthrs/repo-view`, not
 * `@smthrs/ui`, because `@pierre/diffs` is heavy: only a consumer that
 * imports this package pays for it.
 *
 * Plain text is a complete state. pierre paints nothing until the grammar and
 * the theme have loaded, so the view carries the file as a plain `<pre>` and
 * hides it (`data-state="ready"`) on the first render that has lines. The
 * flip and the scroll to the anchored line are DOM work inside pierre's own
 * `onPostRender` callback and a keyed sentinel's ref callback: no effect, no
 * component state.
 *
 * Highlighting runs in pierre's worker pool (workerPool.ts) wherever a
 * Worker exists. It is not cheap on the main thread: Shiki's JavaScript
 * regex engine compiles the grammar inside the first synchronous tokenize,
 * measured at 2.6 s for a 16 KiB TypeScript file under JavaScriptCore (the
 * native shell) and ~300 ms once warm, 436 ms / ~70 ms in Chromium. Off the
 * pool — no Worker, or a pool that failed its probe — the view still renders
 * on the main thread, plain text first.
 *
 * One pierre instance per view for its life: the anchor is pierre's
 * controlled `selectedLines`, and the scroll to a new anchor runs from the
 * sentinel's ref callback, so moving the anchor never remounts pierre and
 * never tokenizes the file again (a remount paid the whole tokenize and
 * flashed the plain text in between).
 *
 * Code intelligence enters through three
 * props and no state: `annotations` render under their lines as light-DOM
 * children pierre slots into the shadow root; a pointer at rest on a token
 * for `restMs` is one `onTokenRest`; ⌘/Ctrl-click on a token is one
 * `onTokenActivate`. Positions are 1-based, the LSP wire's convention. The
 * rest timer is pierre's own token enter/leave pair plus a timeout held in a
 * ref, cleared on leave and on unmount through the frame's ref callback.
 *
 * A language server's answers draw through four more, still without state:
 * `marks` (symbol highlights, and problems as a wavy underline with a bar in
 * the gutter) and `cursor` become one `<style>` in pierre's shadow root,
 * written from a keyed sentinel's ref callback and from `onPostRender`;
 * `hover` is a card under its token, placed by its own ref callback; the
 * arrow keys move the cursor through the symbols pierre drew
 * (`onCursorMove`), and every other key goes to `onKeyDown`.
 */

/** The theme axis the view follows, the same two values the diff view takes. */
export type CodeViewMode = PierreDiffMode;

/**
 * The grammar id pierre infers from a file name, or null when it would fall
 * back to plain text. A caller that would rather keep its own `<pre>` for an
 * unknown language asks this before mounting the view.
 */
export function languageForFile(name: string): string | null {
  if (name === "") return null;
  const language = getFiletypeFromFileName(name);
  return language === "text" ? null : language;
}

/** A token the pointer named: its 1-based line and column (the token's first character) and its text. */
export interface CodeTokenPosition {
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

/** Content rendered under a line (1-based); `key` keeps React and pierre from redrawing an unchanged one. */
export interface CodeLineAnnotation {
  readonly key: string;
  readonly line: number;
  readonly node: ReactNode;
}

/**
 * A mark on the code, 1-based: `symbol` highlights the token starting at
 * `column` (every occurrence of a selected symbol); a problem underlines the
 * tokens starting from `column` up to `end` (exclusive, same line) and marks
 * the line in the gutter.
 */
export interface CodeMark {
  readonly line: number;
  readonly column: number;
  readonly end?: number | undefined;
  readonly kind: "symbol" | "error" | "warning" | "info";
}

/** A problem a hover card lists. */
export interface CodeProblem {
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
}

/** A card under the token at `line` and `column` (1-based): its signature as code, then `body`, then problems. */
export interface CodeHover {
  readonly line: number;
  readonly column: number;
  readonly signature?: string | undefined;
  readonly body?: ReactNode;
  readonly problems?: ReadonlyArray<CodeProblem> | undefined;
}

type AnnotationMeta = { readonly key: string; readonly node: ReactNode };

/** The selector of the token pierre drew starting at a 1-based `line` and `column`. */
const tokenSelector = (line: number, column: number) => `[data-line="${line}"] [data-char="${column - 1}"]`;

/** The most columns one problem underlines, so a long range stays a short sheet. */
const MAX_MARKED_COLUMNS = 200;

const PROBLEM_COLORS: Readonly<Record<CodeProblem["severity"], string>> = {
  error: t.destructive,
  warning: t.warning,
  info: t.info,
};

/** The sheet the marks and the cursor become inside pierre's shadow root. */
export const codeMarksCss = (
  marks: ReadonlyArray<CodeMark>,
  cursor: { readonly line: number; readonly column: number } | undefined,
): string => {
  const rules = marks.map((mark) => {
    if (mark.kind === "symbol") {
      return `${tokenSelector(mark.line, mark.column)}{background:color-mix(in srgb, ${t.primary} 22%, transparent);border-radius:3px}`;
    }
    const color = PROBLEM_COLORS[mark.kind];
    const last = Math.min(Math.max(mark.end ?? mark.column + 1, mark.column + 1), mark.column + MAX_MARKED_COLUMNS);
    const tokens = Array.from({ length: last - mark.column }, (_, offset) => tokenSelector(mark.line, mark.column + offset));
    return `${tokens.join(",")}{text-decoration:underline wavy ${color};text-decoration-skip-ink:none;text-underline-offset:3px}` +
      `[data-column-number="${mark.line}"]{box-shadow:inset 3px 0 ${color}}`;
  });
  if (cursor !== undefined) {
    rules.push(`${tokenSelector(cursor.line, cursor.column)}{outline:2px solid ${t.primary};outline-offset:1px;border-radius:3px}`);
  }
  return rules.join("\n");
};

/** Every symbol pierre drew in `host`'s shadow root, in document order. */
const symbolsIn = (host: Element | null): Array<CodeSymbol> =>
  [...(host?.shadowRoot?.querySelectorAll<HTMLElement>("[data-line] [data-char]") ?? [])].flatMap((token) => {
    const text = token.textContent ?? "";
    const line = Number(token.closest("[data-line]")?.getAttribute("data-line"));
    return isSymbolText(text) ? [{ line, column: Number(token.getAttribute("data-char")) + 1, text }] : [];
  });

const MARKS_SLOT = "code-view-marks";

/** Writes `css` into `host`'s shadow root, in one `<style>` the view owns. Answers false before pierre made the root. */
const writeMarks = (host: Element | null | undefined, css: string): boolean => {
  const root = host?.shadowRoot;
  if (root == null) return false;
  let sheet = root.querySelector<HTMLStyleElement>(`style[data-slot="${MARKS_SLOT}"]`);
  if (sheet === null) {
    sheet = document.createElement("style");
    sheet.setAttribute("data-slot", MARKS_SLOT);
    root.appendChild(sheet);
  }
  if (sheet.textContent !== css) sheet.textContent = css;
  return true;
};

/** Puts `card` under the token it describes, inside the frame; answers false while the token isn't drawn. */
const placeHover = (card: HTMLElement | null, hover: CodeHover | undefined): boolean => {
  const frame = card?.parentElement;
  if (card == null || frame == null || hover === undefined) return false;
  const root = frame.querySelector("diffs-container")?.shadowRoot;
  const target = root?.querySelector<HTMLElement>(tokenSelector(hover.line, hover.column)) ??
    root?.querySelector<HTMLElement>(`[data-line="${hover.line}"]`);
  if (target == null) return false;
  const box = frame.getBoundingClientRect();
  const token = target.getBoundingClientRect();
  card.style.top = `${token.bottom - box.top + 4}px`;
  card.style.left = `${Math.max(0, token.left - box.left)}px`;
  card.setAttribute("data-placed", "");
  return true;
};

/** The default pointer rest before a token counts as hovered. */
export const CODE_VIEW_REST_MS = 300;

export type CodeFileViewProps = {
  /** The file's name or repository path: the grammar comes from its extension. */
  name: string;
  /** The file's text. */
  contents: string;
  /**
   * A 1-based line to anchor: it is marked as the selected line and scrolled
   * to the middle of the nearest scrolling ancestor once it exists. Changing
   * it moves the mark and scrolls again; omitting it clears the mark.
   */
  line?: number | undefined;
  /**
   * The last line of the anchored range, 1-based, when it spans more than
   * `line`: the lines from `line` to here are marked, and `line` is the one
   * scrolled to. A value before `line` marks `line` alone; without `line` it
   * does nothing.
   */
  lineEnd?: number | undefined;
  /** Theme mode. Defaults to the active house theme (`data-theme` on the root). */
  mode?: CodeViewMode | undefined;
  /** Palette override. Defaults to the active `data-palette` value. */
  palette?: ResolvedPalette | undefined;
  /** Use full-contrast inherited text when syntax colours cannot meet the host contrast requirement. */
  monochrome?: boolean | undefined;
  /** Extra class on the frame. */
  className?: string | undefined;
  /** Rendered under their lines; the consumer memoizes the array, a new one redraws pierre's rows. */
  annotations?: ReadonlyArray<CodeLineAnnotation> | undefined;
  /** The pointer rested on a token for `restMs`; fires once per token entered. */
  onTokenRest?: ((token: CodeTokenPosition) => void) | undefined;
  /** How long the pointer rests before `onTokenRest`; defaults to CODE_VIEW_REST_MS. */
  restMs?: number | undefined;
  /** ⌘-click (macOS) or Ctrl-click on a token. */
  onTokenActivate?: ((token: CodeTokenPosition) => void) | undefined;
  /** A plain click on a token, when it selected no text. */
  onTokenSelect?: ((token: CodeTokenPosition) => void) | undefined;
  /** Symbol highlights and problems; the consumer memoizes the array. */
  marks?: ReadonlyArray<CodeMark> | undefined;
  /** The keyboard cursor, outlined and kept in view. */
  cursor?: { readonly line: number; readonly column: number } | undefined;
  /**
   * An arrow key moved the cursor, or the view took focus without one: the
   * symbol it lands on. Present, the code takes focus like a control.
   */
  onCursorMove?: ((token: CodeTokenPosition) => void) | undefined;
  /** Any other key while the code has focus. */
  onKeyDown?: ((event: ReactKeyboardEvent<HTMLDivElement>) => void) | undefined;
  /** A card under a token: what a language server said about it. */
  hover?: CodeHover | undefined;
};

/**
 * The nearest ancestor that owns a scrollbar. The walk takes the first
 * `overflow-y: auto | scroll` element whether or not it overflows right now:
 * that element is the designated scroller, and going past it to the page
 * would scroll a whole transcript to show one line.
 */
const nearestScroller = (from: HTMLElement): HTMLElement | null => {
  for (let element = from.parentElement; element != null; element = element.parentElement) {
    const { overflowY } = getComputedStyle(element);
    if (overflowY === "auto" || overflowY === "scroll") return element;
  }
  return null;
};

/** Scroll `line` to the middle of the nearest scroller. Answers false while pierre has not rendered the line yet. */
const revealLine = (host: HTMLElement, line: number): boolean => {
  const target = host.shadowRoot?.querySelector<HTMLElement>(`[data-line="${line}"]`);
  if (target == null) return false;
  const scroller = nearestScroller(host);
  if (scroller == null) return true;
  const row = target.getBoundingClientRect();
  const box = scroller.getBoundingClientRect();
  if (row.height === 0 && box.height === 0) return true;
  const visible = row.top >= box.top && row.bottom <= box.bottom;
  if (!visible) scroller.scrollTop += row.top - box.top - (box.height - row.height) / 2;
  return true;
};

export function CodeFileView({
  monochrome = false,
  name,
  contents,
  line,
  lineEnd,
  mode,
  palette,
  className,
  annotations,
  onTokenRest,
  restMs = CODE_VIEW_REST_MS,
  onTokenActivate,
  onTokenSelect,
  marks,
  cursor,
  onCursorMove,
  onKeyDown,
  hover,
}: CodeFileViewProps) {
  useInjectRepoViewCss();
  const houseTheme = useResolvedTheme();
  const housePalette = useResolvedPalette();
  const resolvedMode = mode ?? houseTheme;
  const resolvedPalette = palette ?? housePalette;
  const language = languageForFile(name);
  const file = useMemo(() => ({ name, contents }), [name, contents]);
  const selectedLines = useMemo(
    () => (line === undefined ? null : { start: line, end: Math.max(line, lineEnd ?? line) }),
    [line, lineEnd],
  );
  const theme = diffsThemeForMode(resolvedMode, resolvedPalette);

  /*
   * The worker pool, started on the first view and told this view's theme
   * (pierre renders every pooled file with the pool's theme). The live state
   * is an external store: a pool that fails its probe flips `manager` to
   * undefined, and the `key` below remounts pierre on the main thread.
   */
  codeViewWorkerPool(theme);
  const pool = useSyncExternalStore(subscribeCodeViewPool, currentCodeViewPool, currentCodeViewPool);
  const manager = pool.state === "starting" || pool.state === "ready" ? pool.manager : undefined;

  /*
   * The anchor last scrolled to. pierre calls onPostRender on the passes
   * that touch the DOM (mount, the highlight landing, a theme change) and
   * not on a selection-only update, so the first reveal rides onPostRender
   * (the pass where the line first exists) and every later anchor rides the
   * sentinel below, whose ref callback runs on each anchor change after
   * pierre's layout effect has applied the new selection.
   */
  const revealed = useRef<number | null>(null);

  /*
   * The marks and the cursor, as one sheet in pierre's shadow root. The
   * sentinel keyed by the sheet writes it whenever it changes; onPostRender
   * writes it once pierre has made the root. A cursor that moved is scrolled
   * into view once.
   */
  const marksCss = useMemo(() => codeMarksCss(marks ?? [], cursor), [marks, cursor]);
  const scrolledTo = useRef<string | null>(null);
  const applyMarks = (container: Element | null | undefined): void => {
    if (!writeMarks(container, marksCss) || cursor === undefined) return;
    const key = `${cursor.line}:${cursor.column}`;
    const token = container?.shadowRoot?.querySelector<HTMLElement>(tokenSelector(cursor.line, cursor.column));
    if (token == null || scrolledTo.current === key) return;
    scrolledTo.current = key;
    token.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  };
  const marksFromSentinel = (sentinel: HTMLElement | null): void => {
    if (sentinel !== null) applyMarks(sentinel.parentElement?.querySelector("diffs-container"));
  };
  const hoverCard = useRef<HTMLElement | null>(null);
  const hoverId = useId();

  const onPostRender = useStableCallback((node: HTMLElement) => {
    if (node.shadowRoot?.querySelector("[data-line]") == null) return;
    node.parentElement?.setAttribute("data-state", "ready");
    applyMarks(node);
    placeHover(hoverCard.current, hover);
    if (line === undefined) {
      revealed.current = null;
      return;
    }
    if (revealed.current !== line && revealLine(node, line)) revealed.current = line;
  });

  const revealFromSentinel = (sentinel: HTMLElement | null): void => {
    if (sentinel === null) return;
    if (line === undefined) {
      revealed.current = null;
      return;
    }
    const container = sentinel.parentElement?.querySelector<HTMLElement>("diffs-container");
    if (container != null && revealed.current !== line && revealLine(container, line)) revealed.current = line;
  };

  /*
   * The pointer-rest timer. pierre reports token enter and leave from its own
   * pointer listeners inside the shadow root; the view arms one timeout on
   * enter and disarms it on leave, so a pointer crossing tokens fires for
   * the token it stops on and no other. The ref outlives renders; the frame's
   * ref callback disarms it on unmount.
   */
  const rest = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disarm = useStableCallback((): void => {
    if (rest.current !== null) clearTimeout(rest.current);
    rest.current = null;
  });
  // React detaches an inline ref on every commit, cancelling a stationary
  // pointer's pending rest. Detach only when the file changes or unmounts.
  const frameRef = useMemo(() => (node: HTMLDivElement | null): void => {
    if (node === null) disarm();
  }, [file, disarm]);
  const onTokenEnter = useStableCallback((token: { lineNumber: number; lineCharStart: number; tokenText: string }) => {
    disarm();
    if (onTokenRest === undefined) return;
    rest.current = setTimeout(() => {
      rest.current = null;
      onTokenRest({ line: token.lineNumber, column: token.lineCharStart + 1, text: token.tokenText });
    }, restMs);
  });
  const onTokenLeave = useStableCallback(() => disarm());
  const onTokenClick = useStableCallback(
    (token: { lineNumber: number; lineCharStart: number; tokenText: string }, event: MouseEvent) => {
      const position = { line: token.lineNumber, column: token.lineCharStart + 1, text: token.tokenText };
      if (event.metaKey || event.ctrlKey) {
        if (onTokenActivate === undefined) return;
        event.preventDefault();
        onTokenActivate(position);
        return;
      }
      if (onTokenSelect !== undefined && window.getSelection()?.isCollapsed !== false) onTokenSelect(position);
    },
  );
  const interactive = onTokenRest !== undefined || onTokenActivate !== undefined || onTokenSelect !== undefined ||
    onCursorMove !== undefined;

  /*
   * The keyboard. The arrow keys move the cursor through the symbols pierre
   * drew; taking focus from the keyboard without a cursor lands it on the
   * first symbol at or after the anchored line (a pointer that focuses the
   * code picks its own token). Every other key is the consumer's.
   */
  const pointerFocus = useRef(false);
  const keyboard = onCursorMove !== undefined || onKeyDown !== undefined;
  const container = (frame: HTMLElement) => frame.querySelector("diffs-container");
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const plain = !event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey;
    if (onCursorMove !== undefined && plain && CURSOR_KEYS.has(event.key)) {
      event.preventDefault();
      const next = moveCursor(symbolsIn(container(event.currentTarget)), cursor, event.key as CursorKey, line);
      if (next !== undefined) onCursorMove(next);
      return;
    }
    onKeyDown?.(event);
  };
  const handleFocus = (event: ReactFocusEvent<HTMLDivElement>) => {
    const byPointer = pointerFocus.current;
    pointerFocus.current = false;
    if (byPointer || onCursorMove === undefined || cursor !== undefined || event.target !== event.currentTarget) return;
    const first = moveCursor(symbolsIn(container(event.currentTarget)), undefined, "ArrowRight", line);
    if (first !== undefined) onCursorMove(first);
  };

  /*
   * Stable across renders: pierre compares options by key identity and a new
   * object per render would force a full re-render of the code on every
   * React pass. Only the theme axis and the gesture handlers' presence
   * rebuild it. `useTokenTransformer` is what makes pierre mark every token
   * with its column (`data-char`) and keep whitespace out of tokens, which
   * the token events need; it is on only when a gesture is bound.
   */
  const options = useMemo<FileOptions<AnnotationMeta>>(
    () => ({
      theme,
      themeType: resolvedMode,
      disableFileHeader: true,
      // Paper ink keeps Night Owl Light tokens above AA contrast; monochrome replaces syntax colour entirely.
      unsafeCSS: monochrome ? "[data-line] span { color: var(--code-text, currentColor) !important; }" : resolvedMode === "light" ? 'span[style*="color:#4876D6"] { color: var(--lane-1, var(--diffs-light)) !important; } span[style*="color:#C96765"] { color: var(--danger, var(--diffs-light)) !important; }' : undefined,
      overflow: "wrap",
      enableLineSelection: false,
      onPostRender,
      ...(interactive ? { useTokenTransformer: true, onTokenEnter, onTokenLeave, onTokenClick } : {}),
    }),
    [theme, resolvedMode, monochrome, onPostRender, interactive, onTokenEnter, onTokenLeave, onTokenClick],
  );

  const lineAnnotations = useMemo<LineAnnotation<AnnotationMeta>[] | undefined>(
    () =>
      annotations === undefined || annotations.length === 0
        ? undefined
        : annotations.map((annotation) => ({ lineNumber: annotation.line, metadata: { key: annotation.key, node: annotation.node } })),
    [annotations],
  );

  return (
    <div
      ref={frameRef}
      className={cn("sui-code-view", className)}
      data-slot="code-view"
      data-theme-mode={resolvedMode}
      data-palette={resolvedPalette}
      data-language={language ?? "text"}
      data-interactive={interactive ? "" : undefined}
      data-highlighter={manager === undefined ? "main-thread" : "worker"}
      tabIndex={keyboard ? 0 : undefined}
      aria-label={keyboard ? name : undefined}
      aria-describedby={hover === undefined ? undefined : hoverId}
      onKeyDown={keyboard ? handleKeyDown : undefined}
      onFocus={keyboard ? handleFocus : undefined}
      onPointerDown={keyboard ? () => void (pointerFocus.current = true) : undefined}
    >
      <pre className="sui-code-view-plain">{contents}</pre>
      <WorkerPoolContext.Provider value={manager}>
        <File<AnnotationMeta>
          key={manager === undefined ? "main-thread" : "worker"}
          file={file}
          selectedLines={selectedLines}
          options={options}
          lineAnnotations={lineAnnotations}
          renderAnnotation={renderAnnotation}
          disableWorkerPool={manager === undefined}
        />
      </WorkerPoolContext.Provider>
      <span key={line ?? "unanchored"} hidden ref={revealFromSentinel} data-slot="code-view-anchor" />
      <span key={marksCss} hidden ref={marksFromSentinel} data-slot="code-view-marks-anchor" />
      {hover === undefined ? null : (
        <div
          key={`${hover.line}:${hover.column}`}
          id={hoverId}
          role="tooltip"
          className="sui-code-hover"
          data-slot="code-view-hover"
          ref={(card) => {
            hoverCard.current = card;
            placeHover(card, hover);
          }}
        >
          {hover.signature === undefined ? null : <pre className="sui-code-hover-signature">{hover.signature}</pre>}
          {hover.body === undefined || hover.body === null ? null : <div className="sui-code-hover-body">{hover.body}</div>}
          {hover.problems === undefined || hover.problems.length === 0 ? null : (
            <ul className="sui-code-hover-problems">
              {hover.problems.map((problem, index) => (
                <li key={index} data-severity={problem.severity}>{problem.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** The annotation's own node; pierre wraps it in the slotted `<div>` the shadow row shows. */
const renderAnnotation = (annotation: LineAnnotation<AnnotationMeta>): ReactNode => (
  <div key={annotation.metadata.key} className="sui-code-view-annotation" data-slot="code-view-annotation">
    {annotation.metadata.node}
  </div>
);
