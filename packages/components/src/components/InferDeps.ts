import type { DepsSpec } from "./DepsSpec.ts";
import type { InferOutputEntry } from "@smithers-orchestrator/driver/OutputAccessor";

type InferDepValue<T> = T extends string ? unknown : InferOutputEntry<T>;

export type InferDeps<D extends DepsSpec> = {
	[K in keyof D]: InferDepValue<D[K]>;
};
