import type { DevToolsErrorCode } from "./DevToolsErrorCode.ts";
import type { NodeOutputErrorCode } from "./NodeOutputErrorCode.ts";
import type { NodeDiffErrorCode } from "./NodeDiffErrorCode.ts";
import type { JumpToFrameErrorCode } from "./JumpToFrameErrorCode.ts";

export type ProtocolError = {
  code: DevToolsErrorCode | NodeOutputErrorCode | NodeDiffErrorCode | JumpToFrameErrorCode | string;
  message: string;
  hint?: string;
};
