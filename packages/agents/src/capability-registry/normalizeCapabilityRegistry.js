import { normalizeCapabilityStringList } from "./normalizeCapabilityStringList.js";
/** @typedef {import("./AgentToolDescriptor.ts").AgentToolDescriptor} AgentToolDescriptor */

/** @typedef {import("./AgentCapabilityRegistry.ts").AgentCapabilityRegistry} AgentCapabilityRegistry */

/**
 * @param {AgentToolDescriptor | null | undefined} descriptor
 * @returns {AgentToolDescriptor}
 */
function normalizeToolDescriptor(descriptor) {
    return {
        description: descriptor?.description?.trim() || undefined,
        source: descriptor?.source,
    };
}
/**
 * @param {AgentCapabilityRegistry | null | undefined} registry
 * @returns {AgentCapabilityRegistry | null}
 */
export function normalizeCapabilityRegistry(registry) {
    if (!registry) {
        return null;
    }
    const runtimeTools = Object.fromEntries(Object.entries(registry.runtimeTools ?? {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, descriptor]) => [name, normalizeToolDescriptor(descriptor)]));
    return {
        version: 1,
        engine: registry.engine,
        runtimeTools,
        mcp: {
            bootstrap: registry.mcp.bootstrap,
            supportsProjectScope: registry.mcp.supportsProjectScope,
            supportsUserScope: registry.mcp.supportsUserScope,
        },
        skills: registry.skills.supportsSkills
            ? {
                supportsSkills: true,
                installMode: registry.skills.installMode,
                smithersSkillIds: normalizeCapabilityStringList(registry.skills.smithersSkillIds),
            }
            : {
                supportsSkills: false,
                smithersSkillIds: normalizeCapabilityStringList(registry.skills.smithersSkillIds),
            },
        humanInteraction: {
            supportsUiRequests: registry.humanInteraction.supportsUiRequests,
            methods: normalizeCapabilityStringList(registry.humanInteraction.methods),
        },
        builtIns: normalizeCapabilityStringList(registry.builtIns),
    };
}
