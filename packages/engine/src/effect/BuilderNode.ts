import type { BuilderStepHandle } from "./BuilderStepHandle.ts";

type SequenceNode = {
	kind: "sequence";
	children: BuilderNode[];
};
type ParallelNode = {
	kind: "parallel";
	children: BuilderNode[];
	maxConcurrency?: number;
};
type LoopNode = {
	kind: "loop";
	id?: string;
	children: BuilderNode;
	until: (outputs: Record<string, unknown>) => boolean;
	maxIterations?: number;
	onMaxReached?: "fail" | "return-last";
	handles?: BuilderStepHandle[];
};
type MatchNode = {
	kind: "match";
	source: BuilderStepHandle;
	when: (value: unknown) => boolean;
	then: BuilderNode;
	else?: BuilderNode;
};
type BranchNode = {
	kind: "branch";
	condition: (ctx: Record<string, unknown>) => boolean;
	needs?: Record<string, BuilderStepHandle>;
	then: BuilderNode;
	else?: BuilderNode;
};
type WorktreeNode = {
	kind: "worktree";
	id?: string;
	path: string;
	branch?: string;
	skipIf?: (ctx: Record<string, unknown>) => boolean;
	needs?: Record<string, BuilderStepHandle>;
	children: BuilderNode;
};

export type BuilderNode =
	| BuilderStepHandle
	| SequenceNode
	| ParallelNode
	| LoopNode
	| MatchNode
	| BranchNode
	| WorktreeNode;
