import { describe, expect, test } from "bun:test";
import { SOURCES_CITATIONS_CSS_ID, sourcesCitationsCss } from "../src/agentic/sourcesCitationsCss";

/** Strip every var(--x, fallback) expression, including rgba fallbacks. */
function stripVarFallbacks(css: string): string {
  return css.replace(/var\(--[\w-]+(?:,\s*(?:#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|[\w\s.%-]+))?\)/g, "VAR");
}

describe("sources-citations css contract", () => {
  test("exports the frozen lane id", () => {
    expect(SOURCES_CITATIONS_CSS_ID).toBe("sources-citations");
  });

  test("never emits a :root token block", () => {
    expect(sourcesCitationsCss.includes(":root")).toBe(false);
  });

  test("no raw hex colors outside var() fallback position", () => {
    const stripped = stripVarFallbacks(sourcesCitationsCss);
    expect(stripped).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  test("no raw rgb()/rgba() colors outside var() fallback position", () => {
    const stripped = stripVarFallbacks(sourcesCitationsCss)
      .replace(/rgb\(VAR\s*\/\s*[0-9.]+\)/g, "SHADOW")
      .replace(/rgb\(VAR\)/g, "SHADOW");
    expect(stripped).not.toMatch(/rgba?\(/);
  });

  test("all color-mix uses srgb", () => {
    const mixes = sourcesCitationsCss.match(/color-mix\([^,]+/g) ?? [];
    expect(mixes.length).toBeGreaterThan(0);
    for (const mix of mixes) {
      expect(mix).toStartWith("color-mix(in srgb");
    }
  });

  test("every class is sui- namespaced", () => {
    const classes = sourcesCitationsCss.match(/\.[a-zA-Z][a-zA-Z0-9_-]*/g) ?? [];
    expect(classes.length).toBeGreaterThan(0);
    for (const cls of classes) {
      expect(cls.startsWith(".sui-")).toBe(true);
    }
  });

  test("extends the canonical sources/citation prefixes and ships the frozen new prefixes", () => {
    expect(sourcesCitationsCss).toContain(".sui-sources-content");
    expect(sourcesCitationsCss).toContain(".sui-sources-favicon");
    expect(sourcesCitationsCss).toContain(".sui-citation-card");
    expect(sourcesCitationsCss).toContain(".sui-citation-carousel");
    expect(sourcesCitationsCss).toContain(".sui-citation-quote");
    expect(sourcesCitationsCss).toContain(".sui-suggestion");
    expect(sourcesCitationsCss).toContain(".sui-open-in-chat");
  });
});
