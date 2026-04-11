export type WaitReason =
  | { readonly _tag: "Approval"; readonly nodeId: string }
  | { readonly _tag: "Event"; readonly eventName: string }
  | { readonly _tag: "Timer"; readonly resumeAtMs: number }
  | { readonly _tag: "RetryBackoff"; readonly waitMs: number }
  | { readonly _tag: "HotReload" }
  | { readonly _tag: "OrphanRecovery"; readonly count: number }
  | { readonly _tag: "ExternalTrigger" };
