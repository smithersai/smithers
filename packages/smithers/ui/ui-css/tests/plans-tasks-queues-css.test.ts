import { describe, expect, test } from "bun:test";
import { PLANS_TASKS_QUEUES_CSS_ID, plansTasksQueuesCss } from "../src/agentic/plansTasksQueuesCss";

/** Strip every var(--x, fallback) expression, including rgba fallbacks. */
function stripVarFallbacks(css: string): string {
  return css.replace(/var\(--[\w-]+(?:,\s*(?:#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|[\w\s.%-]+))?\)/g, "VAR");
}

describe("plans-tasks-queues css contract", () => {
  test("never emits a :root token block", () => {
    expect(plansTasksQueuesCss.includes(":root")).toBe(false);
  });

  test("no raw hex colors outside var() fallback position", () => {
    const stripped = stripVarFallbacks(plansTasksQueuesCss);
    expect(stripped).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  test("no raw rgb()/rgba() colors outside var() fallback position", () => {
    const stripped = stripVarFallbacks(plansTasksQueuesCss)
      .replace(/rgb\(VAR\s*\/\s*[0-9.]+\)/g, "SHADOW")
      .replace(/rgb\(VAR\)/g, "SHADOW");
    expect(stripped).not.toMatch(/rgba?\(/);
  });

  test("all color-mix uses srgb", () => {
    const mixes = plansTasksQueuesCss.match(/color-mix\([^,]+/g) ?? [];
    expect(mixes.length).toBeGreaterThan(0);
    for (const mix of mixes) {
      expect(mix).toStartWith("color-mix(in srgb");
    }
  });

  test("every class is sui- namespaced", () => {
    const classes = plansTasksQueuesCss.match(/\.[a-zA-Z][a-zA-Z0-9_-]*/g) ?? [];
    expect(classes.length).toBeGreaterThan(0);
    for (const cls of classes) {
      expect(cls.startsWith(".sui-")).toBe(true);
    }
  });

  test("exports the frozen lane id", () => {
    expect(PLANS_TASKS_QUEUES_CSS_ID).toBe("plans-tasks-queues");
  });
});
