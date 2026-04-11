import type { DevToolsSnapshot } from "./DevToolsSnapshot.ts";

export type DevToolsEventHandler = (
  event: "commit" | "unmount",
  snapshot: DevToolsSnapshot,
) => void;
