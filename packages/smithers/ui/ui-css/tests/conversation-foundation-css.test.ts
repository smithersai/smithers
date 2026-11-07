import { describe, expect, test } from "bun:test";
import { conversationFoundationCss, CONVERSATION_FOUNDATION_CSS_ID } from "../src/chat/conversationFoundationCss";

/** Strip every var(--x, fallback) expression, including rgba fallbacks. */
function stripVarFallbacks(css: string): string {
  return css.replace(/var\(--[\w-]+(?:,\s*(?:#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|[\w\s.%-]+))?\)/g, "VAR");
}

describe("conversation-foundation css contract", () => {
  test("exports the frozen lane id", () => {
    expect(CONVERSATION_FOUNDATION_CSS_ID).toBe("conversation-foundation");
  });

  test("never emits a :root token block", () => {
    expect(conversationFoundationCss.includes(":root")).toBe(false);
  });

  test("no raw hex colors outside var() fallback position", () => {
    const stripped = stripVarFallbacks(conversationFoundationCss);
    expect(stripped).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  test("no raw rgb()/rgba() colors: only shadow channels via rgb(var(--shadow-rgb ...))", () => {
    const stripped = stripVarFallbacks(conversationFoundationCss)
      .replace(/rgb\(VAR\s*\/\s*[0-9.]+\)/g, "SHADOW")
      .replace(/rgb\(VAR\)/g, "SHADOW");
    expect(stripped).not.toMatch(/rgba?\(/);
  });

  test("all color-mix uses srgb", () => {
    const mixes = conversationFoundationCss.match(/color-mix\([^,]+/g) ?? [];
    for (const mix of mixes) {
      expect(mix).toStartWith("color-mix(in srgb");
    }
  });

  test("every class is sui- namespaced", () => {
    const classes = conversationFoundationCss.match(/\.[a-zA-Z][a-zA-Z0-9_-]*/g) ?? [];
    expect(classes.length).toBeGreaterThan(0);
    for (const cls of classes) {
      expect(cls.startsWith(".sui-")).toBe(true);
    }
  });

  test("covers the lane anatomy and the content-visibility item optimization", () => {
    for (const klass of [
      ".sui-msg",
      ".sui-msg-avatar",
      ".sui-msg-actions",
      ".sui-msg-branch-page",
      ".sui-bubble-reactions",
      ".sui-compact-group",
      ".sui-convo-checkpoint",
      ".sui-msg-scroller-item",
    ]) {
      expect(conversationFoundationCss).toContain(`${klass} `);
    }
    expect(conversationFoundationCss).toContain("content-visibility:auto");
    expect(conversationFoundationCss).toContain("contain-intrinsic-size:auto var(--sui-msg-intrinsic, 96px)");
  });

  test("ships no per-component motion policy (document-wide policy owns it)", () => {
    expect(conversationFoundationCss).not.toContain("prefers-reduced-motion");
  });
});
