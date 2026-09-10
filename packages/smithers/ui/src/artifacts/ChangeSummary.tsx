/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";

export type ChangeSummaryProps = Omit<ComponentProps<"div">, "children"> & {
  additions: number;
  deletions: number;
  filesChanged: number;
  /** Switches the accessible terminology: git "diff" vs jj "working-copy change". */
  vcs?: "git" | "jj";
  /** Suppress the files-changed segment visually (still announced). */
  compact?: boolean;
};

/** Additions/deletions/changed-file rollup (`+N −M · K files`). */
export function ChangeSummary({
  additions,
  deletions,
  filesChanged,
  vcs = "git",
  compact = false,
  className,
  ...props
}: ChangeSummaryProps) {
  useInjectUiCss();
  const subject = vcs === "jj" ? "working-copy change" : "diff";
  const ariaLabel = `${additions} additions, ${deletions} deletions, ${filesChanged} files changed in this ${subject}`;
  return (
    <div
      data-slot="change-summary"
      data-vcs={vcs}
      data-compact={compact ? "true" : "false"}
      aria-label={ariaLabel}
      className={cn("sui-changesum", className)}
      {...props}
    >
      <span aria-hidden="true" className="sui-changesum-add">+{additions}</span>
      <span aria-hidden="true" className="sui-changesum-del">−{deletions}</span>
      {compact ? null : (
        <span aria-hidden="true" className="sui-changesum-files">· {filesChanged} {filesChanged === 1 ? "file" : "files"}</span>
      )}
    </div>
  );
}
