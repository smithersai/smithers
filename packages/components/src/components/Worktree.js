import React from "react";
import { WORKTREE_EMPTY_PATH_ERROR } from "@smithers/graph/constants";
import { SmithersError } from "@smithers/errors/SmithersError";
/** @typedef {import("./Worktree.ts").WorktreeProps} WorktreeProps */

/**
 * @param {WorktreeProps} props
 */
export function Worktree(props) {
    if (typeof props.path !== "string" || props.path.trim() === "") {
        throw new SmithersError("WORKTREE_EMPTY_PATH", WORKTREE_EMPTY_PATH_ERROR);
    }
    if (props.skipIf)
        return null;
    const next = { id: props.id, path: props.path, branch: props.branch, baseBranch: props.baseBranch };
    return React.createElement("smithers:worktree", next, props.children);
}
