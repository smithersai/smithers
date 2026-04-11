export type SmithersAlertReaction =
  | { kind: "emit-only" }
  | { kind: "pause" }
  | { kind: "cancel" }
  | { kind: "open-approval" }
  | { kind: "deliver"; destination: string };
