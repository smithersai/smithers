import type { GatewayWebhookSignalConfig } from "./GatewayWebhookSignalConfig.js";
import type { GatewayWebhookRunConfig } from "./GatewayWebhookRunConfig.js";

export type GatewayWebhookConfig = {
  secret: string;
  signatureHeader?: string;
  signaturePrefix?: string;
  signal?: GatewayWebhookSignalConfig;
  run?: GatewayWebhookRunConfig;
};
