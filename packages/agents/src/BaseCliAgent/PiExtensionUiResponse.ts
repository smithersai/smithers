export type PiExtensionUiResponse = {
  type: "extension_ui_response";
  id: string;
  value?: string;
  cancelled?: boolean;
  [key: string]: unknown;
};
