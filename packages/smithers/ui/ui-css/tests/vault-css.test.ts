import { describe, expect, test } from "bun:test";
import { VAULT_CSS_ID, vaultCss } from "../src/vault/vaultCss";
import { smithersUiCss } from "../src/uiCss";

/** Strip every var(--x, fallback) expression, including rgba fallbacks. */
function stripVarFallbacks(css: string): string {
  return css.replace(/var\(--[\w-]+(?:,\s*(?:#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|[\w\s.%-]+))?\)/g, "VAR");
}

describe("vault css contract", () => {
  test("uses the frozen lane id", () => {
    expect(VAULT_CSS_ID).toBe("vault");
  });

  test("is composed into the shipped stylesheet", () => {
    expect(smithersUiCss).toContain(vaultCss.trim());
    expect(smithersUiCss.indexOf(vaultCss.trim())).toBeLessThan(smithersUiCss.indexOf("prefers-reduced-motion"));
  });

  test("never emits a :root token block", () => {
    expect(vaultCss.includes(":root")).toBe(false);
  });

  test("no raw hex colors outside var() fallback position", () => {
    const stripped = stripVarFallbacks(vaultCss);
    expect(stripped).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  test("no raw rgb()/rgba() colors", () => {
    const stripped = stripVarFallbacks(vaultCss)
      .replace(/rgb\(VAR\s*\/\s*[0-9.]+\)/g, "SHADOW")
      .replace(/rgb\(VAR\)/g, "SHADOW");
    expect(stripped).not.toMatch(/rgba?\(/);
  });

  test("all color-mix uses srgb", () => {
    const mixes = vaultCss.match(/color-mix\([^,]+/g) ?? [];
    expect(mixes.length).toBeGreaterThan(0);
    for (const mix of mixes) {
      expect(mix).toStartWith("color-mix(in srgb");
    }
  });

  test("every class is sui- namespaced", () => {
    const classes = vaultCss.match(/\.[a-zA-Z][a-zA-Z0-9_-]*/g) ?? [];
    expect(classes.length).toBeGreaterThan(0);
    for (const cls of classes) {
      expect(cls.startsWith(".sui-")).toBe(true);
    }
  });
});
