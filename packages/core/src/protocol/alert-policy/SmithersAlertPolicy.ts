import type { SmithersAlertPolicyDefaults } from "./SmithersAlertPolicyDefaults";
import type { SmithersAlertPolicyRule } from "./SmithersAlertPolicyRule";
import type { SmithersAlertReaction } from "./SmithersAlertReaction";

export type SmithersAlertPolicy = {
  defaults?: SmithersAlertPolicyDefaults;
  rules?: Record<string, SmithersAlertPolicyRule>;
  reactions?: Record<string, SmithersAlertReaction>;
};
