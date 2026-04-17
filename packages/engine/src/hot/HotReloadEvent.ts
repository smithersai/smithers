import type { SmithersWorkflow } from "@smithers/components/SmithersWorkflow";

export type HotReloadEvent =
	| {
			type: "reloaded";
			generation: number;
			changedFiles: string[];
			newBuild: SmithersWorkflow<unknown>["build"];
	  }
	| {
			type: "failed";
			generation: number;
			changedFiles: string[];
			error: unknown;
	  }
	| {
			type: "unsafe";
			generation: number;
			changedFiles: string[];
			reason: string;
	  };
