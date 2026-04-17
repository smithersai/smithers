import type React from "react";

export type BranchProps = {
	if: boolean;
	then: React.ReactElement;
	else?: React.ReactElement | null;
	skipIf?: boolean;
};
