export type PlanNode =
  | { readonly kind: "task"; readonly nodeId: string }
  | { readonly kind: "sequence"; readonly children: readonly PlanNode[] }
  | { readonly kind: "parallel"; readonly children: readonly PlanNode[] }
  | {
      readonly kind: "ralph";
      readonly id: string;
      readonly children: readonly PlanNode[];
      readonly until: boolean;
      readonly maxIterations: number;
      readonly onMaxReached: "fail" | "return-last";
      readonly continueAsNewEvery?: number;
    }
  | {
      readonly kind: "continue-as-new";
      readonly stateJson?: string;
    }
  | { readonly kind: "group"; readonly children: readonly PlanNode[] }
  | {
      readonly kind: "saga";
      readonly id: string;
      readonly actionChildren: readonly PlanNode[];
      readonly compensationChildren: readonly PlanNode[];
      readonly onFailure: "compensate" | "compensate-and-fail" | "fail";
    }
  | {
      readonly kind: "try-catch-finally";
      readonly id: string;
      readonly tryChildren: readonly PlanNode[];
      readonly catchChildren: readonly PlanNode[];
      readonly finallyChildren: readonly PlanNode[];
    };
