import { describe, expect, test } from "bun:test";
import { workflowUiThemeCss } from "@smthrs/ui-styleguide";
import { statusClass, type StatusClass } from "../src/status";

/**
 * The status color must not depend on which surface renders it: a status
 * styled by the styleguide's legacy `.badge.<status>` vocabulary has to land
 * in the same tone bucket as `statusClass()` from this package (which colors
 * every sui- component). "cancelled" once split red vs gray this way.
 */

/** Map the semantic var a badge rule colors with to the shared status class. */
const TONE_BY_VAR: Record<string, StatusClass> = {
  "--success": "ok",
  "--warning": "warn",
  "--brand": "run",
  "--danger": "bad",
  "--muted": "muted",
};

/** Tone alias classes (`.badge.ok`, `.badge.warn`, ...) are not statuses. */
const TONE_ALIAS_CLASSES = new Set(["ok", "warn", "bad", "run", "info", "muted"]);

describe("status vocabulary parity", () => {
  test("every styleguide .badge.<status> tone matches statusClass()", () => {
    const rules = workflowUiThemeCss.match(/\.badge\.[^{]+\{[^}]+\}/g) ?? [];
    let checked = 0;
    for (const rule of rules) {
      const colorVar = rule.match(/color:var\((--[\w-]+)\)/)?.[1];
      const tone = colorVar ? TONE_BY_VAR[colorVar] : undefined;
      if (!tone) continue;
      const statuses = [...rule.matchAll(/\.badge\.([\w-]+)/g)]
        .map((m) => m[1]!)
        .filter((name) => !TONE_ALIAS_CLASSES.has(name));
      for (const status of statuses) {
        expect(`${status}=${statusClass(status)}`).toBe(`${status}=${tone}`);
        checked += 1;
      }
    }
    // finished/success, waiting, running, failed, cancelled/canceled/
    // skipped/pending/queued at minimum.
    expect(checked).toBeGreaterThanOrEqual(9);
  });

  test("pins the once-conflicting statuses on both surfaces", () => {
    expect(statusClass("cancelled")).toBe("muted");
    expect(statusClass("pending")).toBe("muted");
    expect(workflowUiThemeCss).not.toMatch(/\.badge\.warn[^{]*\.badge\.pending/);
    expect(workflowUiThemeCss).toMatch(/\.badge\.cancelled[^{]*\{[^}]*color:var\(--muted\)/);
  });
});
