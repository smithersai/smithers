import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { renderFrame } from "../src/index";
import { buildContext } from "../src/context";

const examplesDir = join(process.cwd(), "examples");
const exampleIds = readdirSync(examplesDir)
  .filter((file) => file.endsWith(".tsx") && !file.startsWith("_"))
  .map((file) => file.replace(/\.tsx$/, ""))
  .sort();

describe("examples (render smoke)", () => {
  for (const exampleId of exampleIds) {
    test(exampleId, async () => {
      const module = await import(`../examples/${exampleId}.tsx`);
      const workflow = module.default;
      const input = (module.sampleInput ?? {}) as Record<string, unknown>;
      const ctx = buildContext({
        runId: `render-${exampleId}`,
        iteration: 0,
        input,
        outputs: {},
        zodToKeyName: (workflow as any).zodToKeyName,
      });

      const frame = await renderFrame(workflow, ctx);

      expect(frame.xml).toBeDefined();
      expect(frame.tasks.length).toBeGreaterThan(0);

      try {
        (workflow.db as any)?.$client?.close?.();
      } catch {}
    });
  }
});
