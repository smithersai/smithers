import { describe, expect, test } from "bun:test";
import { BaseCliAgent } from "../src/BaseCliAgent/index.js";
class TimedAgent extends BaseCliAgent {
    script;
    /**
   * @param {string} script
   * @param {BaseCliAgentOptions} [opts]
   */
    constructor(script, opts = {}) {
        super({ id: "timeout-test-agent", ...opts });
        this.script = script;
    }
    /**
   * @param {{ prompt: string; systemPrompt?: string; cwd: string; options: any; }} _params
   */
    async buildCommand(_params) {
        return {
            command: "bash",
            args: ["-lc", this.script],
        };
    }
}
describe("BaseCliAgent timeouts", () => {
    test("idle timeout resets on stdout activity", async () => {
        const agent = new TimedAgent("for i in 1 2 3 4 5; do echo tick; sleep 0.05; done", { idleTimeoutMs: 150 });
        const result = await agent.generate({ prompt: "run" });
        expect(result.text).toContain("tick");
    });
    test("idle timeout fails after inactivity", async () => {
        const agent = new TimedAgent("echo start; sleep 0.2; echo end", {
            idleTimeoutMs: 80,
        });
        await expect(agent.generate({ prompt: "run" })).rejects.toThrow("CLI idle timed out after 80ms");
    });
    test("hard timeout still applies", async () => {
        const agent = new TimedAgent("sleep 0.2; echo done", {
            timeoutMs: 50,
            idleTimeoutMs: 1000,
        });
        await expect(agent.generate({ prompt: "run" })).rejects.toThrow("CLI timed out after 50ms");
    });
});
