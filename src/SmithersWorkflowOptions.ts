export type SmithersAlertSeverity = "info" | "warning" | "critical";

export type SmithersAlertLabels = Record<string, string>;

export type SmithersAlertPolicyDefaults = {
  owner?: string;
  severity?: SmithersAlertSeverity;
  runbook?: string;
  labels?: SmithersAlertLabels;
};

export type SmithersAlertReactionKind =
  | "emit-only"
  | "pause"
  | "cancel"
  | "open-approval"
  | "deliver";

export type SmithersAlertReaction =
  | { kind: "emit-only" }
  | { kind: "pause" }
  | { kind: "cancel" }
  | { kind: "open-approval" }
  | { kind: "deliver"; destination: string };

export type SmithersAlertReactionRef =
  | string
  | SmithersAlertReaction;

export type SmithersAlertPolicyRule = SmithersAlertPolicyDefaults & {
  afterMs?: number;
  reaction?: SmithersAlertReactionRef;
};

export type SmithersAlertPolicy = {
  defaults?: SmithersAlertPolicyDefaults;
  rules?: Record<string, SmithersAlertPolicyRule>;
  reactions?: Record<string, SmithersAlertReaction>;
};

export type SmithersWorkflowOptions = {
  alertPolicy?: SmithersAlertPolicy;
  cache?: boolean;
  workflowHash?: string;
};
