import { describe, expect, test } from "bun:test";
import { AGENT_IDENTITY_CONTEXT_CSS_ID, agentsCss } from "../src/agents/agentsCss";

/** Strip every var(--x, fallback) expression, including rgba fallbacks. */
function stripVarFallbacks(css: string): string {
  return css.replace(/var\(--[\w-]+(?:,\s*(?:#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|[\w\s.%-]+))?\)/g, "VAR");
}

describe("agent-identity-context css contract", () => {
  test("exports the lane id matching the lane", () => {
    expect(AGENT_IDENTITY_CONTEXT_CSS_ID).toBe("agent-identity-context");
  });

  test("never emits a :root token block", () => {
    expect(agentsCss.includes(":root")).toBe(false);
  });

  test("no raw hex colors outside var() fallback position", () => {
    const stripped = stripVarFallbacks(agentsCss);
    expect(stripped).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  test("no raw rgb()/rgba() colors: only shadow channels via rgb(var(--shadow-rgb ...))", () => {
    const stripped = stripVarFallbacks(agentsCss)
      .replace(/rgb\(VAR\s*\/\s*[0-9.]+\)/g, "SHADOW")
      .replace(/rgb\(VAR\)/g, "SHADOW");
    expect(stripped).not.toMatch(/rgba?\(/);
  });

  test("all color-mix uses srgb", () => {
    const mixes = agentsCss.match(/color-mix\([^,]+/g) ?? [];
    for (const mix of mixes) {
      expect(mix).toStartWith("color-mix(in srgb");
    }
  });

  test("every class is sui- namespaced", () => {
    const classes = agentsCss.match(/\.[a-zA-Z][a-zA-Z0-9_-]*/g) ?? [];
    expect(classes.length).toBeGreaterThan(0);
    for (const cls of classes) {
      expect(cls.startsWith(".sui-")).toBe(true);
    }
  });

  test("covers the frozen lane class families", () => {
    for (const cls of [
      ".sui-agentdef {",
      ".sui-agentcard {",
      ".sui-model-sel-trigger",
      ".sui-model-badge {",
      ".sui-provider-badge {",
      ".sui-ctx {",
      ".sui-ctx-trigger",
      ".sui-ctx-content",
    ]) {
      expect(agentsCss).toContain(cls);
    }
  });
});
