import { describe, expect, test } from "bun:test";
import { PROMPT_ATTACHMENTS_CSS_ID, promptAttachmentsCss } from "../src/prompt/promptAttachmentsCss";

/** Strip every var(--x, fallback) expression, including rgba fallbacks. */
function stripVarFallbacks(css: string): string {
  return css.replace(/var\(--[\w-]+(?:,\s*(?:#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|[\w\s.%-]+))?\)/g, "VAR");
}

describe("prompt-attachments css contract", () => {
  test("exports the frozen lane css id", () => {
    expect(PROMPT_ATTACHMENTS_CSS_ID).toBe("prompt-attachments");
  });

  test("never emits a :root token block", () => {
    expect(promptAttachmentsCss.includes(":root")).toBe(false);
  });

  test("no raw hex colors outside var() fallback position", () => {
    const stripped = stripVarFallbacks(promptAttachmentsCss);
    expect(stripped).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  test("all color-mix uses srgb", () => {
    const mixes = promptAttachmentsCss.match(/color-mix\([^,]+/g) ?? [];
    expect(mixes.length).toBeGreaterThan(0);
    for (const mix of mixes) {
      expect(mix).toStartWith("color-mix(in srgb");
    }
  });

  test("every class is sui- namespaced", () => {
    const classes = promptAttachmentsCss.match(/\.[a-zA-Z][a-zA-Z0-9_-]*/g) ?? [];
    expect(classes.length).toBeGreaterThan(0);
    for (const cls of classes) {
      expect(cls.startsWith(".sui-")).toBe(true);
    }
  });
});
