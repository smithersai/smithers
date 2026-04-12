import React from "react";
export type WorktreeProps = {
    id?: string;
    path: string;
    branch?: string;
    /** Base branch for syncing worktrees (default: "main"). */
    baseBranch?: string;
    skipIf?: boolean;
    children?: React.ReactNode;
};
export declare function Worktree(props: WorktreeProps): React.ReactElement<{
    id?: string;
    path: string;
    branch?: string;
    baseBranch?: string;
}, string | React.JSXElementConstructor<any>> | null;
