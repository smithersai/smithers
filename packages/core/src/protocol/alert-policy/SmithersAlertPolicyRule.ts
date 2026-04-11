import type { SmithersAlertPolicyDefaults } from "./SmithersAlertPolicyDefaults";
import type { SmithersAlertReactionRef } from "./SmithersAlertReactionRef";

export type SmithersAlertPolicyRule = SmithersAlertPolicyDefaults & {
  afterMs?: number;
  reaction?: SmithersAlertReactionRef;
};
