/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import { runWorkflow } from "@smithers/engine";
import workflow from "../../smithers/tests/fixtures/jsx-ai-release-notes";

describe("JSX AI fixtures", () => {
  test("release notes agent summarizes changelog", async () => {
    const result = await runWorkflow(workflow, {
      input: {},
      rootDir: process.cwd(),
    });

    expect(result.status).toBe("finished");
    const rows = result.output as Array<{
      latestVersion: string;
      changeCount: number;
      highlights: string[];
    }>;
    expect(rows[0]?.latestVersion).toBe("1.2.0");
    expect(rows[0]?.changeCount).toBe(2);
    expect(rows[0]?.highlights).toEqual([
      "Add caching for workflow runs",
      "Fix resume input handling",
    ]);
  });
});
