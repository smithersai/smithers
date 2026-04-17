import type { TokenBudgetConfig } from "./TokenBudgetConfig.ts";
import type { LatencySloConfig } from "./LatencySloConfig.ts";
import type { CostBudgetConfig } from "./CostBudgetConfig.ts";
import type { TrackingConfig } from "./TrackingConfig.ts";
import type { AspectAccumulator } from "./AspectAccumulator.ts";

/**
 * The value provided by AspectContext to descendant components.
 */
export type AspectContextValue = {
	tokenBudget?: TokenBudgetConfig;
	latencySlo?: LatencySloConfig;
	costBudget?: CostBudgetConfig;
	tracking: TrackingConfig;
	accumulator: AspectAccumulator;
};
