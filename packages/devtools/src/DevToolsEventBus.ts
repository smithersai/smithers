export type DevToolsEventBus = {
  on: (event: "event", handler: (e: any) => void) => void;
  removeListener: (event: "event", handler: (e: any) => void) => void;
};
