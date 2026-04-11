// PiExtensionUiRequest is defined here because RunRpcCommandOptions references it.
// It is re-exported from PiAgent.ts for the public API barrel.
export type PiExtensionUiRequest = {
  type: "extension_ui_request";
  id: string;
  method: string;
  title?: string;
  placeholder?: string;
  [key: string]: unknown;
};
