import type { GatewayAuthConfig } from "./GatewayAuthConfig.js";
import type { GatewayDefaults } from "./GatewayDefaults.js";

export type GatewayOptions = {
  protocol?: number;
  features?: string[];
  heartbeatMs?: number;
  auth?: GatewayAuthConfig;
  defaults?: GatewayDefaults;
  maxBodyBytes?: number;
  maxPayload?: number;
  maxConnections?: number;
};
