import type { DevToolsEventHandler } from "./DevToolsEventHandler.ts";

export type SmithersDevToolsOptions = {
  /** Called on every renderer commit that touches the Smithers tree */
  onCommit?: DevToolsEventHandler;
  /** Called on every SmithersEvent from an attached EventBus */
  onEngineEvent?: (event: any) => void;
  /** Enable verbose console logging */
  verbose?: boolean;
};
