/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import React, { useState, useEffect, useMemo, useRef } from "react";
import { Workflow, Task, Ralph, runWorkflow } from "smithers";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createTestSmithers } from "./helpers";
import { outputSchemas } from "./schema";

describe("React hooks e2e", () => {
  test("useState setter triggers re-render with updated state", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers(outputSchemas);
    const promptsSeen: string[] = [];

    // This component uses useEffect to call setState exactly once (empty deps).
    // The engine's synchronous render picks up the initial state; then
    // the effect fires, calls setState, and the reconciler re-renders
    // the fiber tree with the new state. The engine re-renders on each
    // Ralph iteration, so we observe the accumulated state.
    function StateUpdater({ iteration }: { iteration: number }) {
      const [label, setLabel] = useState("initial");

      useEffect(() => {
        setLabel("updated-by-effect");
      }, []);

      return (
        <Task
          id="state-task"
          output={outputs.outputA}
          agent={{
            id: "echo",
            tools: {},
            generate: async ({ prompt }: any) => {
              promptsSeen.push(prompt);
              return { output: { value: iteration } };
            },
          } as any}
        >
          {`label:${label}`}
        </Task>
      );
    }

    const workflow = smithers((ctx) => (
      <Workflow name="usestate-setter">
        <Ralph id="loop" maxIterations={3}>
          <StateUpdater iteration={ctx.iteration} />
        </Ralph>
      </Workflow>
    ));

    const result = await runWorkflow(workflow, { input: {} });
    expect(result.status).toBe("finished");

    // The effect should have set label to "updated-by-effect".
    // At least one prompt must contain the updated state.
    const hasUpdatedState = promptsSeen.some((p) =>
      p.includes("label:updated-by-effect"),
    );
    expect(hasUpdatedState).toBe(true);
    cleanup();
  });

  test("useEffect fires and produces observable side effects", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers(outputSchemas);
    const sideEffectLog: string[] = [];

    function EffectComponent() {
      const [effectRan, setEffectRan] = useState(false);

      useEffect(() => {
        sideEffectLog.push("effect-fired");
        setEffectRan(true);
      }, []);

      return (
        <Task
          id="effect-task"
          output={outputs.outputA}
          agent={{
            id: "echo",
            tools: {},
            generate: async () => ({ output: { value: effectRan ? 1 : 0 } }),
          } as any}
        >
          {`ready:${effectRan}`}
        </Task>
      );
    }

    const workflow = smithers((_ctx) => (
      <Workflow name="useeffect-side-effect">
        <EffectComponent />
      </Workflow>
    ));

    const result = await runWorkflow(workflow, { input: {} });
    expect(result.status).toBe("finished");

    // The effect must have fired
    expect(sideEffectLog.length).toBeGreaterThanOrEqual(1);
    expect(sideEffectLog).toContain("effect-fired");
    cleanup();
  });

  test("useRef persists across re-renders in a Ralph loop", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers(outputSchemas);
    const refValues: number[] = [];

    function RefTracker() {
      const renderCount = useRef(0);
      renderCount.current += 1;
      refValues.push(renderCount.current);

      return (
        <Task
          id="ref-task"
          output={outputs.outputA}
          agent={{
            id: "echo",
            tools: {},
            generate: async () => ({ output: { value: renderCount.current } }),
          } as any}
        >
          {`ref:${renderCount.current}`}
        </Task>
      );
    }

    const workflow = smithers((_ctx) => (
      <Workflow name="useref-test">
        <Ralph id="loop" maxIterations={2}>
          <RefTracker />
        </Ralph>
      </Workflow>
    ));

    const result = await runWorkflow(workflow, { input: {} });
    expect(result.status).toBe("finished");

    // useRef value persists across renders — later values must be > first
    expect(refValues.length).toBeGreaterThanOrEqual(2);
    expect(refValues[refValues.length - 1]).toBeGreaterThan(refValues[0]!);
    cleanup();
  });

  test("useEffect with changing deps re-fires on each Ralph iteration", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers(outputSchemas);
    const effectIterations: number[] = [];

    function IterationTracker({ iteration }: { iteration: number }) {
      const [trackedIteration, setTrackedIteration] = useState(-1);

      useEffect(() => {
        effectIterations.push(iteration);
        setTrackedIteration(iteration);
      }, [iteration]);

      return (
        <Task
          id="iter-task"
          output={outputs.outputA}
          agent={{
            id: "echo",
            tools: {},
            generate: async () => ({ output: { value: trackedIteration } }),
          } as any}
        >
          {`tracked:${trackedIteration}`}
        </Task>
      );
    }

    const workflow = smithers((ctx) => (
      <Workflow name="effect-deps">
        <Ralph id="loop" maxIterations={3}>
          <IterationTracker iteration={ctx.iteration} />
        </Ralph>
      </Workflow>
    ));

    const result = await runWorkflow(workflow, { input: {} });
    expect(result.status).toBe("finished");

    // useEffect should have fired for multiple distinct iteration values
    expect(effectIterations.length).toBeGreaterThanOrEqual(2);
    const unique = new Set(effectIterations);
    expect(unique.size).toBeGreaterThanOrEqual(2);
    cleanup();
  });
});

describe("TanStack Query e2e", () => {
  test("useQuery with initialData flows through a full workflow run", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers(outputSchemas);
    let capturedValue: number | undefined;

    function QueryComponent() {
      const queryClient = useMemo(
        () =>
          new QueryClient({
            defaultOptions: { queries: { retry: false } },
          }),
        [],
      );

      return (
        <QueryClientProvider client={queryClient}>
          <DataTask outputs={outputs} />
        </QueryClientProvider>
      );
    }

    function DataTask({ outputs: o }: { outputs: typeof outputs }) {
      const { data } = useQuery({
        queryKey: ["workflow-data"],
        queryFn: async () => ({ value: 999 }),
        initialData: { value: 42 },
      });

      return (
        <Task
          id="query-task"
          output={o.outputA}
          agent={{
            id: "echo",
            tools: {},
            generate: async () => {
              capturedValue = data.value;
              return { output: { value: data.value } };
            },
          } as any}
        >
          {`fetched:${data.value}`}
        </Task>
      );
    }

    const workflow = smithers((_ctx) => (
      <Workflow name="tanstack-e2e">
        <QueryComponent />
      </Workflow>
    ));

    const result = await runWorkflow(workflow, { input: {} });
    expect(result.status).toBe("finished");
    // The agent must have received the query data (initialData=42 or fetched=999)
    expect(capturedValue).toBeDefined();
    expect(typeof capturedValue).toBe("number");
    cleanup();
  });
});
