import { describe, expect, test } from "bun:test";
import { canvasCss, WORKFLOW_CANVAS_CSS_ID } from "../src/canvas/canvasCss";

/** Strip every var(--x, fallback) expression, including rgba fallbacks. */
function stripVarFallbacks(css: string): string {
  return css.replace(/var\(--[\w-]+(?:,\s*(?:#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|[\w\s.%-]+))?\)/g, "VAR");
}

describe("workflow-canvas css contract", () => {
  test("uses the frozen lane id", () => {
    expect(WORKFLOW_CANVAS_CSS_ID).toBe("workflow-canvas");
  });

  test("never emits a :root token block", () => {
    expect(canvasCss.includes(":root")).toBe(false);
  });

  test("no raw hex colors outside var() fallback position", () => {
    const stripped = stripVarFallbacks(canvasCss);
    expect(stripped).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  test("no raw rgb()/rgba() colors: only shadow channels via rgb(var(--shadow-rgb ...))", () => {
    const stripped = stripVarFallbacks(canvasCss)
      .replace(/rgb\(VAR\s*\/\s*[0-9.]+\)/g, "SHADOW")
      .replace(/rgb\(VAR\)/g, "SHADOW");
    expect(stripped).not.toMatch(/rgba?\(/);
  });

  test("all color-mix uses srgb", () => {
    const mixes = canvasCss.match(/color-mix\([^,]+/g) ?? [];
    for (const mix of mixes) {
      expect(mix).toStartWith("color-mix(in srgb");
    }
  });

  test("every class is sui- namespaced", () => {
    const classes = canvasCss.match(/\.[a-zA-Z][a-zA-Z0-9_-]*/g) ?? [];
    expect(classes.length).toBeGreaterThan(0);
    for (const cls of classes) {
      expect(cls.startsWith(".sui-")).toBe(true);
    }
  });

  test("delegates motion policy: no per-component reduced-motion overrides", () => {
    expect(canvasCss).not.toContain("@media (prefers-reduced-motion: reduce)");
  });

  test("edge status glyph rules exist per status class (non-color signifier)", () => {
    expect(canvasCss).toContain(".sui-canvas-edge-glyph {");
    for (const statusClass of ["run", "ok", "warn", "bad"]) {
      expect(canvasCss).toContain(`.sui-canvas-edge[data-status-class='${statusClass}'] .sui-canvas-edge-glyph`);
    }
  });

  test("covers every shipped data-slot", () => {
    for (const cls of [
      ".sui-canvas {",
      ".sui-canvas-node {",
      ".sui-canvas-node-header {",
      ".sui-canvas-node-content {",
      ".sui-canvas-node-status {",
      ".sui-canvas-edge {",
      ".sui-canvas-connection {",
      ".sui-canvas-controls {",
      ".sui-canvas-panel {",
      ".sui-canvas-toolbar {",
      ".sui-canvas-minimap {",
    ]) {
      expect(canvasCss).toContain(cls);
    }
  });
});
