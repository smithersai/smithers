import type { Exit } from "effect";
import type { ApprovalDeferredResolution } from "./ApprovalDeferredResolution.ts";

export type DeferredResolution = Exit.Exit<
	ApprovalDeferredResolution | void,
	never
>;
