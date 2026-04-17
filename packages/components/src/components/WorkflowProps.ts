import type React from "react";

export type WorkflowProps = {
	name: string;
	cache?: boolean;
	children?: React.ReactNode;
};
