import type React from "react";
import type { SmithersErrorCode } from "@smithers-orchestrator/errors/SmithersErrorCode";
import type { SmithersError } from "@smithers-orchestrator/errors/SmithersError";

export type TryCatchFinallyProps = {
	id?: string;
	try: React.ReactElement;
	catch?: React.ReactElement | ((error: SmithersError) => React.ReactElement);
	catchErrors?: SmithersErrorCode[];
	finally?: React.ReactElement;
	skipIf?: boolean;
};
