/** @jsxImportSource react */
import type { CSSProperties } from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";

/** The Smithers mark: six rows of box-drawing text, each the same width. */
export const WORDMARK: readonly string[] = [
  "███████╗███╗   ███╗██╗████████╗██╗  ██╗███████╗██████╗ ███████╗",
  "██╔════╝████╗ ████║██║╚══██╔══╝██║  ██║██╔════╝██╔══██╗██╔════╝",
  "███████╗██╔████╔██║██║   ██║   ███████║█████╗  ██████╔╝███████╗",
  "╚════██║██║╚██╔╝██║██║   ██║   ██╔══██║██╔══╝  ██╔══██╗╚════██║",
  "███████║██║ ╚═╝ ██║██║   ██║   ██║  ██║███████╗██║  ██║███████║",
  "╚══════╝╚═╝     ╚═╝╚═╝   ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚══════╝",
];

export type WordmarkProps = { className?: string };

// Box-drawing cells as geometry: browser minimum font preferences cannot enlarge the decorative mark.
const ink: Readonly<Record<string, string>> = {
  "█": "M0 0h10v18H0z",
  "═": "M0 5h10v2H0zM0 11h10v2H0z",
  "║": "M2 0h2v18H2zM7 0h2v18H7z",
  "╔": "M2 5h8v2H4v11H2zM7 11h3v2H9v5H7z",
  "╗": "M0 5h9v13H7V7H0zM0 11h4v7H2v-5H0z",
  "╚": "M2 0h2v11h6v2H2zM7 0h2v5h1v2H7z",
  "╝": "M7 0h2v13H0v-2h7zM2 0h2v7H0V5h2z",
};

/**
 * The Smithers mark in brand color, sized to the viewport, with an entrance
 * scan and a hover ripple. It is decorative (`aria-hidden`), so give the
 * surrounding element the accessible name, for example
 * `<h1 aria-label="Smithers"><Wordmark /></h1>`.
 */
export function Wordmark({ className }: WordmarkProps) {
  useInjectUiCss();
  return (
    <svg className={cn("sui-wordmark", className)} aria-hidden="true" focusable="false"
      viewBox={`0 0 ${WORDMARK[0]!.length * 10} ${WORDMARK.length * 18}`} width="608" height="104">
      {WORDMARK.map((line, row) => (
        <g key={row} className="sui-wordmark-row" style={{ "--sui-wordmark-row": row } as CSSProperties}>
          {[...line].flatMap((cell, column) => cell === " " ? [] : [
            <path key={column} d={ink[cell]} transform={`translate(${column * 10} ${row * 18})`} />,
          ])}
        </g>
      ))}
    </svg>
  );
}
