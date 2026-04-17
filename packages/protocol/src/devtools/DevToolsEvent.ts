import type { DevToolsSnapshot } from "./DevToolsSnapshot.ts";
import type { DevToolsDelta } from "./DevToolsDelta.ts";

export type DevToolsEvent =
  | {
      version: 1;
      kind: "snapshot";
      snapshot: DevToolsSnapshot;
    }
  | {
      version: 1;
      kind: "delta";
      delta: DevToolsDelta;
    };
