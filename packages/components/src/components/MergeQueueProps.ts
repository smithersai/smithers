import type React from "react";

/**
 * Queue tasks so that at most `maxConcurrency` run concurrently across the group.
 * Defaults to 1, providing an easy merge queue primitive.
 */
export type MergeQueueProps = {
	id?: string;
	maxConcurrency?: number;
	skipIf?: boolean;
	children?: React.ReactNode;
};
