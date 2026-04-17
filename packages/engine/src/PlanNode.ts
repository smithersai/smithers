export type PlanNode =
	| { kind: "task"; nodeId: string }
	| { kind: "sequence"; children: PlanNode[] }
	| { kind: "parallel"; children: PlanNode[] }
	| {
			kind: "ralph";
			id: string;
			children: PlanNode[];
			until: boolean;
			maxIterations: number;
			onMaxReached: "fail" | "return-last";
			continueAsNewEvery?: number;
	  }
	| { kind: "continue-as-new"; stateJson?: string }
	| { kind: "group"; children: PlanNode[] }
	| {
			kind: "saga";
			id: string;
			actionChildren: PlanNode[];
			compensationChildren: PlanNode[];
			onFailure: "compensate" | "compensate-and-fail" | "fail";
	  }
	| {
			kind: "try-catch-finally";
			id: string;
			tryChildren: PlanNode[];
			catchChildren: PlanNode[];
			finallyChildren: PlanNode[];
	  };
