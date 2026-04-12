import { hashCapabilityRegistry, normalizeCapabilityRegistry, } from "../capability-registry/index.js";
import { createClaudeCodeCapabilityRegistry } from "../ClaudeCodeAgent.js";
import { createCodexCapabilityRegistry } from "../CodexAgent.js";
import { createGeminiCapabilityRegistry } from "../GeminiAgent.js";
import { createKimiCapabilityRegistry } from "../KimiAgent.js";
import { createPiCapabilityRegistry } from "../PiAgent.js";
/** @typedef {import("./CliAgentCapabilityReportEntry.ts").CliAgentCapabilityReportEntry} CliAgentCapabilityReportEntry */

const CLI_AGENT_CAPABILITY_ADAPTERS = [
    {
        id: "claude",
        binary: "claude",
        buildRegistry: () => createClaudeCodeCapabilityRegistry(),
    },
    {
        id: "codex",
        binary: "codex",
        buildRegistry: () => createCodexCapabilityRegistry(),
    },
    {
        id: "gemini",
        binary: "gemini",
        buildRegistry: () => createGeminiCapabilityRegistry(),
    },
    {
        id: "kimi",
        binary: "kimi",
        buildRegistry: () => createKimiCapabilityRegistry(),
    },
    {
        id: "pi",
        binary: "pi",
        buildRegistry: () => createPiCapabilityRegistry(),
    },
];
/**
 * @returns {CliAgentCapabilityReportEntry[]}
 */
export function getCliAgentCapabilityReport() {
    return CLI_AGENT_CAPABILITY_ADAPTERS.map((adapter) => {
        const capabilities = normalizeCapabilityRegistry(adapter.buildRegistry());
        if (!capabilities) {
            throw new Error(`Capability registry missing for adapter ${adapter.id}`);
        }
        return {
            id: adapter.id,
            binary: adapter.binary,
            fingerprint: hashCapabilityRegistry(capabilities),
            capabilities,
        };
    });
}
