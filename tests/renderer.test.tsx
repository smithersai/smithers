/** @jsxImportSource smithers */
import React from "react";
import { describe, expect, test } from "bun:test";
import { SmithersRenderer } from "../src/dom/renderer";
import { Task, Workflow } from "../src/components";
import { outputA } from "./schema";

const fakeAgent: any = {
  id: "fake",
  tools: {},
  generate: async () => ({ output: { value: 1 } }),
};

describe("MDX prompt error handling", () => {
  test("throws when agent task prompt element has invalid type", async () => {
    const renderer = new SmithersRenderer();
    // Simulate an unloaded MDX import: a React element whose type is a module
    // object instead of a component function, e.g. { default: "/path/to.mdx" }
    const brokenMdx = React.createElement(
      { default: "/path/to/Prompt.mdx" } as any,
      {},
    );
    await expect(
      renderer.render(
        <Workflow name="w">
          <Task id="t" output={outputA} agent={fakeAgent}>
            {brokenMdx}
          </Task>
        </Workflow>,
      ),
    ).rejects.toThrow("Task prompt could not be rendered");
  });
});

describe("renderer updates", () => {
  test("commitUpdate applies new props", async () => {
    const renderer = new SmithersRenderer();
    const first = await renderer.render(
      <Workflow name="w">
        <Task id="t" output={outputA} skipIf>
          {{ value: 1 }}
        </Task>
      </Workflow>,
    );
    expect(first.tasks[0]?.skipIf).toBe(true);
    expect(first.tasks[0]?.staticPayload).toEqual({ value: 1 });

    const second = await renderer.render(
      <Workflow name="w">
        <Task id="t" output={outputA} skipIf={false}>
          {{ value: 2 }}
        </Task>
      </Workflow>,
    );
    expect(second.tasks[0]?.skipIf).toBe(false);
    expect(second.tasks[0]?.staticPayload).toEqual({ value: 2 });
  });
});
