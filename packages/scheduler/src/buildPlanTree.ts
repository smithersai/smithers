import type { XmlNode } from "@smithers/graph";
import type { PlanNode } from "./PlanNode.ts";
import type { RalphMeta } from "./RalphMeta.ts";
import type { RalphStateMap } from "./RalphStateMap.ts";
export declare function buildPlanTree(xml: XmlNode | null, ralphState?: RalphStateMap): {
    readonly plan: PlanNode | null;
    readonly ralphs: readonly RalphMeta[];
};
