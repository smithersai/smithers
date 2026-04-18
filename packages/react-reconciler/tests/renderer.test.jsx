/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { SmithersRenderer } from "../src/dom/renderer.js";
import { Task, Workflow } from "@smithers-orchestrator/components/components/index";
import { outputSchemas } from "../../smithers/tests/schema.js";
describe("renderer updates", () => {
    test("commitUpdate applies new props", async () => {
        const renderer = new SmithersRenderer();
        const first = await renderer.render(<Workflow name="w">
        <Task id="t" output={outputSchemas.outputA} skipIf>
          {{ value: 1 }}
        </Task>
      </Workflow>);
        expect(first.tasks[0]?.skipIf).toBe(true);
        expect(first.tasks[0]?.staticPayload).toEqual({ value: 1 });
        const second = await renderer.render(<Workflow name="w">
        <Task id="t" output={outputSchemas.outputA} skipIf={false}>
          {{ value: 2 }}
        </Task>
      </Workflow>);
        expect(second.tasks[0]?.skipIf).toBe(false);
        expect(second.tasks[0]?.staticPayload).toEqual({ value: 2 });
    });
});
