import type { CheckConfig } from "./CheckConfig.ts";
import type { OutputTarget } from "./OutputTarget.ts";

export type CheckSuiteProps = {
	id?: string;
	checks: CheckConfig[] | Record<string, Omit<CheckConfig, "id">>;
	verdictOutput: OutputTarget;
	strategy?: "all-pass" | "majority" | "any-pass";
	maxConcurrency?: number;
	continueOnFail?: boolean;
	skipIf?: boolean;
};
