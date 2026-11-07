import { describe, expect, test } from "bun:test";
import { REASONING_TOOLS_CSS_ID, reasoningToolsCss } from "../src/agentic/reasoningToolsCss";

/** Strip every var(--x, fallback) expression, including rgba fallbacks. */
function stripVarFallbacks(css: string): string {
  return css.replace(/var\(--[\w-]+(?:,\s*(?:#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|[\w\s.%-]+))?\)/g, "VAR");
}

describe("reasoning-tools css fragment contract", () => {
  test("exports the frozen lane id", () => {
    expect(REASONING_TOOLS_CSS_ID).toBe("reasoning-tools");
  });

  test("never emits a :root token block", () => {
    expect(reasoningToolsCss.includes(":root")).toBe(false);
  });

  test("no raw hex colors outside var() fallback position", () => {
    const stripped = stripVarFallbacks(reasoningToolsCss);
    expect(stripped).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  test("no raw rgb()/rgba() colors outside var() fallback position", () => {
    const stripped = stripVarFallbacks(reasoningToolsCss)
      .replace(/rgb\(VAR\s*\/\s*[0-9.]+\)/g, "SHADOW")
      .replace(/rgb\(VAR\)/g, "SHADOW");
    expect(stripped).not.toMatch(/rgba?\(/);
  });

  test("all color-mix uses srgb", () => {
    const mixes = reasoningToolsCss.match(/color-mix\([^,]+/g) ?? [];
    for (const mix of mixes) {
      expect(mix).toStartWith("color-mix(in srgb");
    }
  });

  test("every class is sui- namespaced", () => {
    const classes = reasoningToolsCss.match(/\.[a-zA-Z][a-zA-Z0-9_-]*/g) ?? [];
    expect(classes.length).toBeGreaterThan(0);
    for (const cls of classes) {
      expect(cls.startsWith(".sui-")).toBe(true);
    }
  });
});
