// @smithers-type-exports-begin
/** @typedef {import("./capability-registry/AgentCapabilityRegistry.ts").AgentCapabilityRegistry} AgentCapabilityRegistry */
/** @typedef {import("./AgentLike.ts").AgentLike} AgentLike */
/** @typedef {import("./capability-registry/AgentToolDescriptor.ts").AgentToolDescriptor} AgentToolDescriptor */
/**
 * @template [CALL_OPTIONS=never]
 * @template [TOOLS=import("ai").ToolSet]
 * @typedef {import("./AnthropicAgentOptions.ts").AnthropicAgentOptions<CALL_OPTIONS, TOOLS>} AnthropicAgentOptions
 */
/**
 * @template [CALL_OPTIONS=never]
 * @template [TOOLS=import("ai").ToolSet]
 * @typedef {import("./OpenAIAgentOptions.ts").OpenAIAgentOptions<CALL_OPTIONS, TOOLS>} OpenAIAgentOptions
 */
/** @typedef {import("./PiAgentOptions.ts").PiAgentOptions} PiAgentOptions */
/** @typedef {import("./BaseCliAgent/PiExtensionUiRequest.ts").PiExtensionUiRequest} PiExtensionUiRequest */
/** @typedef {import("./BaseCliAgent/PiExtensionUiResponse.ts").PiExtensionUiResponse} PiExtensionUiResponse */
/** @typedef {import("./agent-contract/SmithersAgentContract.ts").SmithersAgentContract} SmithersAgentContract */
/** @typedef {import("./agent-contract/SmithersAgentContractTool.ts").SmithersAgentContractTool} SmithersAgentContractTool */
/** @typedef {import("./agent-contract/SmithersAgentToolCategory.ts").SmithersAgentToolCategory} SmithersAgentToolCategory */
/** @typedef {import("./agent-contract/SmithersListedTool.ts").SmithersListedTool} SmithersListedTool */
/** @typedef {import("./agent-contract/SmithersToolSurface.ts").SmithersToolSurface} SmithersToolSurface */
// @smithers-type-exports-end

export { BaseCliAgent } from "./BaseCliAgent/index.js";
export { hashCapabilityRegistry } from "./capability-registry/index.js";
export { AnthropicAgent } from "./AnthropicAgent.js";
export { OpenAIAgent } from "./OpenAIAgent.js";
export { AmpAgent } from "./AmpAgent.js";
export { ClaudeCodeAgent } from "./ClaudeCodeAgent.js";
export { CodexAgent } from "./CodexAgent.js";
export { GeminiAgent } from "./GeminiAgent.js";
export { PiAgent } from "./PiAgent.js";
export { KimiAgent } from "./KimiAgent.js";
export { ForgeAgent } from "./ForgeAgent.js";
export { createSmithersAgentContract } from "./agent-contract/createSmithersAgentContract.js";
export { renderSmithersAgentPromptGuidance } from "./agent-contract/renderSmithersAgentPromptGuidance.js";
export { zodToOpenAISchema } from "./zodToOpenAISchema.js";
export { sanitizeForOpenAI } from "./sanitizeForOpenAI.js";
