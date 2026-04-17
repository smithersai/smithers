import type { BaseCliAgentOptions } from "./BaseCliAgent/BaseCliAgentOptions";
import type { PiExtensionUiRequest } from "./BaseCliAgent/PiExtensionUiRequest";
import type { PiExtensionUiResponse } from "./BaseCliAgent/PiExtensionUiResponse";

export type PiAgentOptions = BaseCliAgentOptions & {
  provider?: string;
  model?: string;
  apiKey?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  mode?: "text" | "json" | "rpc";
  print?: boolean;
  continue?: boolean;
  resume?: boolean;
  session?: string;
  sessionDir?: string;
  noSession?: boolean;
  models?: string | string[];
  listModels?: boolean | string;
  tools?: string[];
  noTools?: boolean;
  extension?: string[];
  noExtensions?: boolean;
  skill?: string[];
  noSkills?: boolean;
  promptTemplate?: string[];
  noPromptTemplates?: boolean;
  theme?: string[];
  noThemes?: boolean;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  export?: string;
  files?: string[];
  verbose?: boolean;
  onExtensionUiRequest?: (
    request: PiExtensionUiRequest,
  ) =>
    | Promise<PiExtensionUiResponse | null>
    | PiExtensionUiResponse
    | null;
};
