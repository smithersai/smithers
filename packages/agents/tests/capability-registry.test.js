import { describe, expect, test } from "bun:test";
import React from "react";
import { z } from "zod";
import { Workflow, Task, runWorkflow } from "smithers";
import { ClaudeCodeAgent } from "../src/ClaudeCodeAgent.js";
import { CodexAgent } from "../src/CodexAgent.js";
import { GeminiAgent } from "../src/GeminiAgent.js";
import { KimiAgent } from "../src/KimiAgent.js";
import { PiAgent } from "../src/PiAgent.js";
import { hashCapabilityRegistry, } from "../src/capability-registry/index.js";
import { createTestSmithers } from "../../smithers/tests/helpers.js";
import { createTempRepo, runSmithers } from "../../smithers/tests/e2e-helpers.js";
import { Effect } from "effect";
/**
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
function withMutedWarn(fn) {
    const originalWarn = console.warn;
    console.warn = () => { };
    try {
        return fn();
    }
    finally {
        console.warn = originalWarn;
    }
}
/**
 * @param {AgentCapabilityRegistry["mcp"]} mcp
 * @param {AgentCapabilityRegistry["skills"]} skills
 * @returns {AgentCapabilityRegistry}
 */
function makeCapabilityRegistry(mcp, skills) {
    return {
        version: 1,
        engine: "codex",
        runtimeTools: {},
        mcp,
        skills,
        humanInteraction: {
            supportsUiRequests: false,
            methods: [],
        },
        builtIns: ["default"],
    };
}
describe("capability registry hashing", () => {
    test("fingerprint changes when MCP bootstrap mode changes", () => {
        const projectConfig = makeCapabilityRegistry({
            bootstrap: "project-config",
            supportsProjectScope: true,
            supportsUserScope: true,
        }, {
            supportsSkills: false,
            smithersSkillIds: [],
        });
        const inlineConfig = makeCapabilityRegistry({
            bootstrap: "inline-config",
            supportsProjectScope: true,
            supportsUserScope: false,
        }, {
            supportsSkills: false,
            smithersSkillIds: [],
        });
        expect(hashCapabilityRegistry(projectConfig)).not.toBe(hashCapabilityRegistry(inlineConfig));
    });
    test("fingerprint changes when skills differ", () => {
        const withoutSkills = new PiAgent();
        const withSkills = new PiAgent({
            skill: ["smithers/core", "smithers/review"],
        });
        expect(hashCapabilityRegistry(withoutSkills.capabilities)).not.toBe(hashCapabilityRegistry(withSkills.capabilities));
        expect(withSkills.capabilities.skills.smithersSkillIds).toEqual([
            "smithers/core",
            "smithers/review",
        ]);
    });
});
describe("CLI adapter capability registries", () => {
    test("built-in CLI agents populate capabilities", () => {
        const claude = withMutedWarn(() => new ClaudeCodeAgent());
        const codex = new CodexAgent();
        const gemini = new GeminiAgent();
        const kimi = new KimiAgent();
        const pi = new PiAgent();
        expect(claude.capabilities).toMatchObject({
            version: 1,
            engine: "claude-code",
            mcp: {
                bootstrap: "project-config",
            },
            skills: {
                supportsSkills: true,
                installMode: "plugin",
            },
            humanInteraction: {
                supportsUiRequests: false,
            },
        });
        expect(codex.capabilities).toMatchObject({
            version: 1,
            engine: "codex",
            mcp: {
                bootstrap: "inline-config",
            },
            skills: {
                supportsSkills: false,
            },
        });
        expect(gemini.capabilities).toMatchObject({
            version: 1,
            engine: "gemini",
            mcp: {
                bootstrap: "allow-list",
            },
        });
        expect(kimi.capabilities).toMatchObject({
            version: 1,
            engine: "kimi",
            mcp: {
                bootstrap: "project-config",
            },
            skills: {
                supportsSkills: true,
                installMode: "dir",
            },
        });
        expect(pi.capabilities).toMatchObject({
            version: 1,
            engine: "pi",
            mcp: {
                bootstrap: "unsupported",
            },
            skills: {
                supportsSkills: true,
                installMode: "files",
            },
            humanInteraction: {
                supportsUiRequests: true,
                methods: ["extension_ui_request"],
            },
        });
    });
});
describe("engine cache capability fingerprint", () => {
    test("cache key changes when capabilities change even if agent.tools stays empty", async () => {
        const { smithers, outputs, cleanup } = createTestSmithers({
            out: z.object({ v: z.number() }),
        });
        let calls = 0;
        const capabilityA = makeCapabilityRegistry({
            bootstrap: "inline-config",
            supportsProjectScope: true,
            supportsUserScope: false,
        }, {
            supportsSkills: false,
            smithersSkillIds: [],
        });
        const capabilityB = makeCapabilityRegistry({
            bootstrap: "inline-config",
            supportsProjectScope: true,
            supportsUserScope: false,
        }, {
            supportsSkills: true,
            installMode: "files",
            smithersSkillIds: ["smithers/review"],
        });
        /**
     * @param {AgentCapabilityRegistry} capabilities
     */
        const makeAgent = (capabilities) => ({
            id: "capability-cache-agent",
            tools: {},
            capabilities,
            generate: async () => {
                calls += 1;
                return { output: { v: calls } };
            },
        });
        /**
     * @param {AgentCapabilityRegistry} capabilities
     */
        const makeWorkflow = (capabilities) => smithers(() => React.createElement(Workflow, { name: "capability-cache", cache: true }, React.createElement(Task, {
            id: "t",
            output: outputs.out,
            agent: makeAgent(capabilities),
            children: "Same prompt",
        })));
        await Effect.runPromise(runWorkflow(makeWorkflow(capabilityA), { input: {}, runId: "r1" }));
        await Effect.runPromise(runWorkflow(makeWorkflow(capabilityB), { input: {}, runId: "r2" }));
        expect(calls).toBe(2);
        cleanup();
    });
    test("agents without registries still hash to a stable fallback and cache normally", async () => {
        expect(hashCapabilityRegistry(null)).toBe(hashCapabilityRegistry(undefined));
        const { smithers, outputs, cleanup } = createTestSmithers({
            out: z.object({ v: z.number() }),
        });
        let calls = 0;
        const legacyAgent = {
            id: "legacy-agent",
            tools: {},
            generate: async () => {
                calls += 1;
                return { output: { v: calls } };
            },
        };
        const workflow = smithers(() => React.createElement(Workflow, { name: "legacy-capability-cache", cache: true }, React.createElement(Task, {
            id: "t",
            output: outputs.out,
            agent: legacyAgent,
            children: "Same prompt",
        })));
        await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "legacy-r1" }));
        await Effect.runPromise(runWorkflow(workflow, { input: {}, runId: "legacy-r2" }));
        expect(calls).toBe(1);
        cleanup();
    });
});
describe("smithers agents capabilities", () => {
    test("prints a stable JSON report for each built-in CLI adapter", () => {
        const repo = createTempRepo();
        const result = runSmithers(["agents", "capabilities"], {
            cwd: repo.dir,
            format: null,
        });
        expect(result.exitCode).toBe(0);
        const report = JSON.parse(result.stdout);
        expect(report.map((entry) => entry.id)).toEqual([
            "claude",
            "codex",
            "gemini",
            "kimi",
            "pi",
        ]);
        expect(report.find((entry) => entry.id === "codex")?.capabilities.mcp.bootstrap)
            .toBe("inline-config");
        expect(report.find((entry) => entry.id === "pi")?.capabilities.humanInteraction.supportsUiRequests).toBe(true);
        expect(result.stdout).toBe(`${JSON.stringify(report, null, 2)}\n`);
    });
});
