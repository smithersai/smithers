import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { renderHydratedExampleFrame } from "./example-fixtures";

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
      const { frame } = await renderHydratedExampleFrame(
        workflow,
        exampleId,
        (module.sampleInput ?? {}) as Record<string, unknown>,
      );

      expect(frame.xml).toBeDefined();
      expect(frame.tasks.length).toBeGreaterThan(0);

      try {
        (workflow.db as any)?.$client?.close?.();
      } catch {}
    });
  }
});
