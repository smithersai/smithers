import type { GatewayTokenGrant } from "./GatewayTokenGrant.js";

export type GatewayAuthConfig =
  | {
      mode: "token";
      tokens: Record<string, GatewayTokenGrant>;
    }
  | {
      mode: "jwt";
      issuer: string;
      audience: string | string[];
      secret: string;
      scopesClaim?: string;
      roleClaim?: string;
      userClaim?: string;
      defaultRole?: string;
      defaultScopes?: string[];
      clockSkewSeconds?: number;
    }
  | {
      mode: "trusted-proxy";
      trustedHeaders?: string[];
      allowedOrigins?: string[];
      defaultRole?: string;
      defaultScopes?: string[];
    };
