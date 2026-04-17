import type { BaseCliAgentOptions } from "./BaseCliAgent/BaseCliAgentOptions";

export type ForgeAgentOptions = BaseCliAgentOptions & {
  directory?: string;
  provider?: string;
  agent?: string;
  conversationId?: string;
  sandbox?: string;
  restricted?: boolean;
  verbose?: boolean;
  workflow?: string;
  event?: string;
  conversation?: string;
};
