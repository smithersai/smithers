/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { Badge } from "../badge";
import { cn } from "@smthrs/ui-css";
import { useInjectUiCss } from "../styles";
import { RUN_WORD_GLYPHS, RUN_WORD_TONES, type RunState, type RunWord, runWord } from "./runPage";

export type RunStatusPillProps = Omit<ComponentProps<"span">, "children"> & {
  state: RunState;
  cancelRequested?: boolean;
  /** A word that overrides the state's, such as `On another device`. */
  word?: RunWord;
};

/** A run's state as glyph, tone and one word (`✓ Done`, `◌ Stopping`). `data-word` carries the word. */
export function RunStatusPill({ state, cancelRequested = false, word, className, ...props }: RunStatusPillProps) {
  useInjectUiCss();
  const shown = word ?? runWord(state, { cancelRequested });
  return (
    <Badge
      variant={RUN_WORD_TONES[shown]}
      data-slot="run-status"
      data-state={state}
      data-word={shown}
      className={cn("sui-run-status", className)}
      {...props}
    >
      <span aria-hidden className="sui-run-status-glyph">
        {RUN_WORD_GLYPHS[shown]}
      </span>
      {shown}
    </Badge>
  );
}
