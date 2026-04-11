import type { CorrelationContext } from "./CorrelationContext.ts";

export type CorrelationPatch = Partial<CorrelationContext> | undefined | null;
