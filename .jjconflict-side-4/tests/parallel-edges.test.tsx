/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import { SmithersRenderer } from "../src/dom/renderer";
import { Parallel, Task, Workflow, runWorkflow } from "../src/index.ts";
import { createTestSmithers, sleep } from "./helpers";
import { outputSchemas } from "./schema";

function buildSmithers() {
  return createTestSmithers(outputSchemas);
}

describe("<Parallel> edge maxConcurrency semantics", () => {
  test("extract: non-positive => undefined (unbounded); fractional floored", async () => {
    const renderer = new SmithersRenderer();
    const base = (
      <>
        <Task id="p1" output={outputSchemas.outputC}>
          {{ value: 1 }}
        </Task>
        <Task id="p2" output={outputSchemas.outputC}>
          {{ value: 2 }}
        </Task>
      </>
    );

    // 0 => undefined
    let res = await renderer.render(
      <Workflow name="par-edge-0">
        <Parallel maxConcurrency={0}>{base}</Parallel>
      </Workflow>,
    );
    expect(res.tasks[0]!.parallelMaxConcurrency).toBeUndefined();
    expect(res.tasks[1]!.parallelMaxConcurrency).toBeUndefined();

    // -1 => undefined
    res = await renderer.render(
      <Workflow name="par-edge-neg">
        <Parallel maxConcurrency={-1}>{base}</Parallel>
      </Workflow>,
    );
    expect(res.tasks[0]!.parallelMaxConcurrency).toBeUndefined();
    expect(res.tasks[1]!.parallelMaxConcurrency).toBeUndefined();

    // 2.9 => 2 (floor)
    res = await renderer.render(
      <Workflow name="par-edge-frac">
        <Parallel maxConcurrency={2.9}>{base}</Parallel>
      </Workflow>,
    );
    expect(res.tasks[0]!.parallelMaxConcurrency).toBe(2);
    expect(res.tasks[1]!.parallelMaxConcurrency).toBe(2);
  });

  test("engine: non-positive => only global limit applies (unbounded group)", async () => {
    const { smithers, cleanup, outputs } = buildSmithers();
    let current = 0, peak = 0;
    const agent: any = {
      id: "fake",
      generate: async () => {
        current += 1;
        peak = Math.max(peak, current);
        await sleep(25);
        current -= 1;
        return { output: { value: 1 } };
      },
    };

    async function runWith(mc: any) {
      peak = 0;
      const wf = smithers((_ctx) => (
        <Workflow name={`par-edge-run-${String(mc)}`}>
          <Parallel maxConcurrency={mc}>
            {Array.from({ length: 6 }, (_, i) => (
              <Task key={`p${i}`} id={`p${mc}-${i}`} output={outputs.outputC} agent={agent}>
                run task
              </Task>
            ))}
          </Parallel>
        </Workflow>
      ));
      const result = await runWorkflow(wf, { input: {}, maxConcurrency: 3 });
      expect(result.status).toBe("finished");
      // Should not be capped by group; should reach global 3
      expect(peak).toBeGreaterThanOrEqual(3);
      expect(peak).toBeLessThanOrEqual(3);
    }

    await runWith(0);
    await runWith(-1);
    cleanup();
  });

  test("engine: fractional floors to integer cap", async () => {
    const { smithers, cleanup, outputs } = buildSmithers();
    let current = 0, peak = 0;
    const agent: any = {
      id: "fake",
      generate: async () => {
        current += 1;
        peak = Math.max(peak, current);
        await sleep(25);
        current -= 1;
        return { output: { value: 1 } };
      },
    };

    const wf = smithers((_ctx) => (
      <Workflow name="par-frac">
        <Parallel maxConcurrency={2.9}>
          {Array.from({ length: 5 }, (_, i) => (
            <Task key={`pf${i}`} id={`pf${i}`} output={outputs.outputC} agent={agent}>
              run task
            </Task>
          ))}
        </Parallel>
      </Workflow>
    ));
    const result = await runWorkflow(wf, { input: {}, maxConcurrency: 4 });
    expect(result.status).toBe("finished");
    expect(peak).toBeLessThanOrEqual(2);
    cleanup();
  });
});
