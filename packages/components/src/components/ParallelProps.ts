import type React from "react";

export type ParallelProps = {
	id?: string;
	maxConcurrency?: number;
	skipIf?: boolean;
	children?: React.ReactNode;
};
