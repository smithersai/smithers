import type React from "react";

export type WorktreeProps = {
	id?: string;
	path: string;
	branch?: string;
	/** Base branch for syncing worktrees (default: "main"). */
	baseBranch?: string;
	skipIf?: boolean;
	children?: React.ReactNode;
};
