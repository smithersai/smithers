import React from "react";
import { WORKTREE_EMPTY_PATH_ERROR } from "../constants";

export type WorktreeProps = {
  id?: string;
  path: string;
  branch?: string;
  /** Base branch for syncing worktrees (default: "main"). */
  baseBranch?: string;
  skipIf?: boolean;
  children?: React.ReactNode;
};

export function Worktree(props: WorktreeProps) {
  if (typeof props.path !== "string" || props.path.trim() === "") {
    throw new Error(WORKTREE_EMPTY_PATH_ERROR);
  }
  if (props.skipIf) return null;
  const next: { id?: string; path: string; branch?: string; baseBranch?: string } = { id: props.id, path: props.path, branch: props.branch, baseBranch: props.baseBranch };
  return React.createElement("smithers:worktree", next, props.children);
}
