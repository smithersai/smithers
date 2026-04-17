import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { SmithersError } from "@smithers/errors";
/** @typedef {import("./AgentAvailability.ts").AgentAvailability} AgentAvailability */
/** @typedef {import("./AgentAvailabilityStatus.ts").AgentAvailabilityStatus} AgentAvailabilityStatus */

const DETECTORS = [
    {
        id: "claude",
        binary: "claude",
        authSignals: (homeDir) => [join(homeDir, ".claude")],
        apiKeys: ["ANTHROPIC_API_KEY"],
    },
    {
        id: "codex",
        binary: "codex",
        authSignals: (homeDir) => [join(homeDir, ".codex")],
        apiKeys: ["OPENAI_API_KEY"],
    },
    {
        id: "gemini",
        binary: "gemini",
        authSignals: (homeDir) => [join(homeDir, ".gemini", "oauth_creds.json")],
        apiKeys: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
    },
    {
        id: "pi",
        binary: "pi",
        authSignals: (homeDir) => [join(homeDir, ".pi", "agent", "auth.json")],
        apiKeys: [],
    },
    {
        id: "kimi",
        binary: "kimi",
        authSignals: (homeDir, env) => {
            const signals = [join(homeDir, ".kimi")];
            if (env.KIMI_SHARE_DIR)
                signals.push(resolve(env.KIMI_SHARE_DIR));
            return signals;
        },
        apiKeys: [],
    },
    {
        id: "amp",
        binary: "amp",
        authSignals: (homeDir) => [join(homeDir, ".amp")],
        apiKeys: [],
    },
];
const ROLE_PREFERENCES = {
    spec: ["claude", "codex"],
    research: ["gemini", "kimi", "codex", "claude"],
    plan: ["gemini", "codex", "claude", "kimi"],
    implement: ["codex", "amp", "gemini", "claude", "kimi"],
    validate: ["codex", "amp", "gemini"],
    review: ["claude", "amp", "codex"],
};
const AGENT_VARIANTS = [
    {
        derivedFrom: "claude",
        variantId: "claudeSonnet",
        constructor: {
            importName: "ClaudeCodeAgent",
            expr: 'new ClaudeCodeAgent({ model: "claude-sonnet-4-6" })',
        },
    },
];
const TIER_PREFERENCES = {
    cheapFast: { order: ["kimi", "claudeSonnet", "gemini", "pi"], maxSize: 2 },
    smart: { order: ["codex", "claude", "kimi", "gemini", "amp"], maxSize: 3 },
    smartTool: { order: ["claude", "codex", "kimi", "gemini", "amp"], maxSize: 3 },
};
const CONSTRUCTORS = {
    claude: {
        importName: "ClaudeCodeAgent",
        expr: 'new ClaudeCodeAgent({ model: "claude-opus-4-6" })',
    },
    codex: {
        importName: "CodexAgent",
        expr: 'new CodexAgent({ model: "gpt-5.3-codex", skipGitRepoCheck: true })',
    },
    gemini: {
        importName: "GeminiAgent",
        expr: 'new GeminiAgent({ model: "gemini-3.1-pro-preview" })',
    },
    pi: {
        importName: "PiAgent",
        expr: 'new PiAgent({ provider: "openai", model: "gpt-5.3-codex" })',
    },
    kimi: {
        importName: "KimiAgent",
        expr: 'new KimiAgent({ model: "kimi-latest" })',
    },
    amp: {
        importName: "AmpAgent",
        expr: "new AmpAgent()",
    },
};
/**
 * @param {string} binary
 * @param {NodeJS.ProcessEnv} env
 */
function commandExists(binary, env) {
    const result = spawnSync("/bin/bash", ["-c", `command -v ${binary}`], {
        env,
        encoding: "utf8",
    });
    return result.status === 0;
}
/**
 * @param {boolean} hasBinary
 * @param {boolean} hasAuthSignal
 * @param {boolean} hasApiKeySignal
 * @returns {AgentAvailabilityStatus}
 */
function computeStatus(hasBinary, hasAuthSignal, hasApiKeySignal) {
    if (hasBinary && hasAuthSignal)
        return "likely-subscription";
    if (hasBinary && hasApiKeySignal)
        return "api-key";
    if (hasBinary)
        return "binary-only";
    if (hasAuthSignal)
        return "likely-subscription";
    if (hasApiKeySignal)
        return "api-key";
    return "unavailable";
}
/**
 * @param {AgentAvailabilityStatus} status
 */
function scoreStatus(status) {
    switch (status) {
        case "likely-subscription":
            return 4;
        case "api-key":
            return 3;
        case "binary-only":
            return 2;
        default:
            return 0;
    }
}
/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {AgentAvailability[]}
 */
export function detectAvailableAgents(env = process.env) {
    const homeDir = env.HOME ?? homedir();
    return DETECTORS.map((detector) => {
        const authSignals = detector.authSignals(homeDir, env);
        const hasBinary = commandExists(detector.binary, env);
        const hasAuthSignal = authSignals.some((signal) => existsSync(signal));
        const hasApiKeySignal = detector.apiKeys.some((name) => Boolean(env[name]));
        const status = computeStatus(hasBinary, hasAuthSignal, hasApiKeySignal);
        return {
            id: detector.id,
            binary: detector.binary,
            hasBinary,
            hasAuthSignal,
            hasApiKeySignal,
            status,
            score: scoreStatus(status),
            usable: scoreStatus(status) > 0,
            checks: [
                `binary:${detector.binary}:${hasBinary ? "yes" : "no"}`,
                ...authSignals.map((signal) => `auth:${signal}:${existsSync(signal) ? "yes" : "no"}`),
                ...detector.apiKeys.map((name) => `env:${name}:${env[name] ? "yes" : "no"}`),
            ],
        };
    });
}
/**
 * @param {AgentAvailability[]} available
 */
function fallbackAgents(available) {
    return [...available].sort((left, right) => {
        if (right.score !== left.score)
            return right.score - left.score;
        return DETECTORS.findIndex((detector) => detector.id === left.id) -
            DETECTORS.findIndex((detector) => detector.id === right.id);
    });
}
/**
 * @param {string} role
 * @param {AgentAvailability[]} available
 */
function resolveRoleAgents(role, available) {
    const preferred = ROLE_PREFERENCES[role] ?? [];
    const filtered = preferred
        .map((id) => available.find((entry) => entry.id === id))
        .filter((entry) => Boolean(entry));
    if (filtered.length > 0)
        return filtered;
    return fallbackAgents(available);
}
/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function generateAgentsTs(env = process.env) {
    const detections = detectAvailableAgents(env);
    const available = detections.filter((entry) => entry.usable);
    if (available.length === 0) {
        throw new SmithersError("NO_USABLE_AGENTS", `No usable agents detected. Checked: ${detections.flatMap((entry) => entry.checks).join(", ")}`);
    }
    // Base providers in detection order
    const orderedProviders = DETECTORS
        .map((detector) => available.find((entry) => entry.id === detector.id))
        .filter((entry) => Boolean(entry));
    // Derive variants (e.g. claudeSonnet from claude)
    const availableIds = new Set(orderedProviders.map((p) => p.id));
    const activeVariants = AGENT_VARIANTS.filter((v) => availableIds.has(v.derivedFrom));
    // Collect all import names (dedup)
    const importNames = new Set();
    for (const provider of orderedProviders)
        importNames.add(CONSTRUCTORS[provider.id].importName);
    for (const variant of activeVariants)
        importNames.add(variant.constructor.importName);
    // Provider lines: base + variants
    const providerLines = [
        ...orderedProviders.map((provider) => `  ${provider.id}: ${CONSTRUCTORS[provider.id].expr},`),
        ...activeVariants.map((variant) => `  ${variant.variantId}: ${variant.constructor.expr},`),
    ];
    // All known provider/variant IDs for tier resolution
    const allProviderIds = new Set([
        ...orderedProviders.map((p) => p.id),
        ...activeVariants.map((v) => v.variantId),
    ]);
    // Fallback: all base provider IDs sorted by score (for tiers with no preferred match)
    const fallbackIds = orderedProviders.map((p) => p.id);
    // Tier lines
    const tierLines = Object.entries(TIER_PREFERENCES).map(([tier, { order, maxSize }]) => {
        let resolved = order
            .filter((id) => allProviderIds.has(id))
            .slice(0, maxSize);
        // Fallback to any available base providers if no preferred agents matched
        if (resolved.length === 0) {
            resolved = fallbackIds.slice(0, maxSize);
        }
        return `  ${tier}: [${resolved.map((id) => `providers.${id}`).join(", ")}],`;
    });
    return [
        "// smithers-source: generated",
        `import { ${[...importNames].join(", ")}, type AgentLike } from "smithers-orchestrator";`,
        "",
        "export const providers = {",
        ...providerLines,
        "} as const;",
        "",
        "export const agents = {",
        ...tierLines,
        "} as const satisfies Record<string, AgentLike[]>;",
        "",
    ].join("\n");
}
