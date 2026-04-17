import { describe, expect, test } from "bun:test";
import { createSmithersAgentContract, renderSmithersAgentPromptGuidance, } from "../src/agent-contract/index.js";
import { buildSmithersPiSystemPrompt } from "smithers-orchestrator/pi-plugin/extension";
/**
 * @param {string} text
 */
function extractBacktickedNames(text) {
    return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}
describe("smithers agent contract", () => {
    test("contract renderer only references provided tools", () => {
        for (const toolSurface of ["semantic", "raw"]) {
            const contract = createSmithersAgentContract({
                serverName: "smithers",
                toolSurface,
                tools: [
                    {
                        name: "list_workflows",
                        description: "List discovered local Smithers workflows.",
                    },
                    {
                        name: "run_workflow",
                        description: "Start a discovered workflow directly through the engine.",
                    },
                    {
                        name: "list_runs",
                        description: "List recent Smithers runs with stable structured summaries.",
                    },
                    {
                        name: "get_run",
                        description: "Get enriched structured state for a specific run.",
                    },
                    {
                        name: "cancel",
                        description: "Destructive: cancel a running Smithers run.",
                    },
                ],
            });
            const toolNames = new Set(contract.tools.map((tool) => tool.name));
            const mentionedToolNames = new Set([
                ...extractBacktickedNames(contract.promptGuidance),
                ...extractBacktickedNames(contract.docsGuidance),
            ]);
            const staleMentions = [...mentionedToolNames].filter((name) => !toolNames.has(name));
            expect(staleMentions).toEqual([]);
        }
    });
    test("PI prompt stays in sync with the generated contract guidance", () => {
        const contract = createSmithersAgentContract({
            serverName: "smithers",
            toolSurface: "semantic",
            tools: [
                {
                    name: "list_runs",
                    description: "List recent Smithers runs with stable structured summaries.",
                },
                {
                    name: "get_run",
                    description: "Get enriched structured state for a specific run.",
                },
                {
                    name: "resolve_approval",
                    description: "Destructive: approve or deny a pending approval.",
                },
            ],
        });
        const prompt = buildSmithersPiSystemPrompt("Base system prompt\n", "Docs body", contract);
        expect(prompt).toContain(renderSmithersAgentPromptGuidance(contract, {
            toolNamePrefix: "smithers_",
        }));
        expect(prompt).toContain("`smithers_list_runs`");
        expect(prompt).toContain("`smithers_get_run`");
        expect(prompt).toContain("`smithers_resolve_approval`");
        expect(prompt).not.toContain("`smithers_run_workflow`");
    });
    test("stale Smithers PI aliases are absent", () => {
        const contract = createSmithersAgentContract({
            serverName: "smithers",
            toolSurface: "semantic",
            tools: [
                {
                    name: "list_workflows",
                    description: "List discovered local Smithers workflows.",
                },
                {
                    name: "run_workflow",
                    description: "Start a discovered workflow directly through the engine.",
                },
                {
                    name: "list_runs",
                    description: "List recent Smithers runs with stable structured summaries.",
                },
            ],
        });
        const prompt = buildSmithersPiSystemPrompt("Base system prompt\n", "Docs body", contract);
        const staleAliases = [
            /`smithers_run`/,
            /`smithers_status`/,
            /`smithers_list`/,
            /`smithers_resume`/,
            /`smithers_graph`/,
            /`smithers_frames`/,
        ];
        for (const pattern of staleAliases) {
            expect(contract.promptGuidance).not.toMatch(pattern);
            expect(prompt).not.toMatch(pattern);
        }
    });
});
