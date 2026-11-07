/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { cn } from "@smthrs/ui-css";
import { useInjectUiCss } from "./styles";
import type { DiffFile } from "./diff";
import {
  binaryBodyLabel,
  detectBinary,
  fileLineCount,
  paginateHunks,
  PAGINATE_THRESHOLD,
  PAGINATE_VISIBLE,
} from "./diff-paginate";

const SIGN: Record<string, string> = { context: " ", add: "+", del: "−" };

export type DiffHunksProps = Omit<ComponentProps<"div">, "children"> & {
  /** The file to render, already parsed (see `parseUnifiedFile`). */
  file: DiffFile;
  /**
   * Whether the paginated tail is shown. Defaults to `true` (render everything).
   * Thread this from the caller's own state — the component keeps no store.
   */
  revealed?: boolean;
  /** Called when the "Expand remaining N lines" button is pressed. */
  onReveal?: () => void;
};

/**
 * Render a file's unified diff grouped into hunks. Each hunk is a `@@ … @@`
 * header row (a "···" gutter plus the header text) above its line rows, and
 * every line row has TWO line-number gutters — old then new — a sign glyph, and
 * the text. When the file exceeds {@link PAGINATE_THRESHOLD} lines and the
 * caller has not revealed the tail, only the first {@link PAGINATE_VISIBLE}
 * lines render, followed by an "Expand remaining N lines" button.
 *
 * A binary file has no hunks to show, so it renders the sized placeholder
 * {@link binaryBodyLabel} names instead. That is the behavior `DiffFile.isBinary`
 * has always documented ("a content pane renders a placeholder, never hunks");
 * before this it documented nothing, because the component simply rendered an
 * empty body for a file whose `lines` the parser had deliberately left empty.
 *
 * A file the parser could not read whole (`DiffFile.partial`) renders a warning
 * above its hunks, so a patch cut mid-hunk never reads as the complete change.
 * That warning is what `DiffFile.partial` has always documented and what this
 * component never drew.
 *
 * `revealed` / `onReveal` are caller-threaded so the pagination state lives
 * wherever the caller keeps its state, never in this component.
 */
export function DiffHunks({ file, revealed = true, onReveal, className, ...props }: DiffHunksProps) {
  useInjectUiCss();
  if (detectBinary(file)) {
    return (
      <div data-slot="diff-hunks" data-binary="true" className={cn("sui-diff", className)} {...props}>
        <div className="sui-diff-binary">{binaryBodyLabel(file)}</div>
      </div>
    );
  }
  const total = fileLineCount(file);
  const paginated = total > PAGINATE_THRESHOLD && !revealed;
  const visibleCount = paginated ? PAGINATE_VISIBLE : total;
  const { hunks, hidden } = paginateHunks(file, visibleCount);

  return (
    <div
      data-slot="diff-hunks"
      {...(file.partial === true ? { "data-partial": "true" } : {})}
      className={cn("sui-diff", className)}
      {...props}
    >
      {file.partial === true ? (
        <div className="sui-diff-partial" role="status">
          Partial diff: some hunks could not be parsed.
        </div>
      ) : null}
      {hunks.map((hunk, hunkIndex) => (
        <div key={hunk.header || hunkIndex}>
          {hunk.header ? (
            <div className="sui-diff-hunk-head">
              <span className="sui-diff-hunk-gutter">···</span>
              <span className="sui-diff-hunk-header">{hunk.header}</span>
            </div>
          ) : null}
          {hunk.lines.map((line, lineIndex) => (
            <div className={`sui-diff-line sui-diff-${line.kind}`} key={lineIndex}>
              <span className="sui-diff-ln sui-diff-ln-old">{line.lnOld ?? ""}</span>
              <span className="sui-diff-ln sui-diff-ln-new">{line.ln ?? ""}</span>
              <span className="sui-diff-sign">{SIGN[line.kind]}</span>
              <span className="sui-diff-text">{line.text}</span>
            </div>
          ))}
        </div>
      ))}
      {paginated && hidden > 0 ? (
        <div className="sui-diff-paginate">
          <button className="sui-diff-paginate-btn" type="button" onClick={onReveal}>
            Expand remaining {hidden} lines
          </button>
        </div>
      ) : null}
    </div>
  );
}
