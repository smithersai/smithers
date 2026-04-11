/** @jsxImportSource smithers */
import { describe, expect, test } from "bun:test";
import React from "react";
import {
  Task,
  Workflow,
  Sequence,
  Parallel,
  Branch,
  Loop,
  Ralph,
  MergeQueue,
  Worktree,
  Approval,
  approvalDecisionSchema,
} from "../src/components";
import { SmithersRenderer } from "@smithers/react-reconciler/dom/renderer";
import { z } from "zod";

async function render(el: React.ReactElement) {
  const renderer = new SmithersRenderer();
  return renderer.render(el);
}

describe("Task component", () => {
  test("renders agent task with prompt", async () => {
    const agent = { generate: async () => ({}) };
    const result = await render(
      <Task id="t1" output="out" agent={agent}>
        Write code
      </Task>,
    );
    expect(result.tasks[0].prompt).toBe("Write code");
    expect(result.tasks[0].agent).toBe(agent);
  });

  test("renders compute task", async () => {
    const fn = () => ({ val: 1 });
    const result = await render(
      <Task id="t1" output="out">
        {fn}
      </Task>,
    );
    expect(result.tasks[0].computeFn).toBe(fn);
  });

  test("renders static task", async () => {
    const result = await render(
      <Task id="t1" output="out">
        {{ value: 42 }}
      </Task>,
    );
    expect(result.tasks[0].staticPayload).toEqual({ value: 42 });
  });

  test("agent chain with fallbackAgent", async () => {
    const primary = { id: "p", generate: async () => ({}) };
    const fallback = { id: "f", generate: async () => ({}) };
    const result = await render(
      <Task id="t1" output="out" agent={primary} fallbackAgent={fallback}>
        prompt
      </Task>,
    );
    const chain = result.tasks[0].agent;
    expect(Array.isArray(chain)).toBe(true);
    expect((chain as any[]).length).toBe(2);
  });

  test("agent array with fallback appended", async () => {
    const a1 = { id: "1", generate: async () => ({}) };
    const a2 = { id: "2", generate: async () => ({}) };
    const fb = { id: "fb", generate: async () => ({}) };
    const result = await render(
      <Task id="t1" output="out" agent={[a1, a2]} fallbackAgent={fb}>
        prompt
      </Task>,
    );
    const chain = result.tasks[0].agent as any[];
    expect(chain.length).toBe(3);
  });

  test("passes through retries, timeoutMs, heartbeatTimeoutMs, continueOnFail", async () => {
    const result = await render(
      <Task
        id="t1"
        output="out"
        retries={3}
        timeoutMs={5000}
        heartbeatTimeoutMs={2000}
        continueOnFail
      >
        {{ v: 1 }}
      </Task>,
    );
    expect(result.tasks[0].retries).toBe(3);
    expect(result.tasks[0].timeoutMs).toBe(5000);
    expect(result.tasks[0].heartbeatTimeoutMs).toBe(2000);
    expect(result.tasks[0].continueOnFail).toBe(true);
  });

  test("noRetry maps to zero retries", async () => {
    const result = await render(
      <Task id="t1" output="out" noRetry>
        {{ v: 1 }}
      </Task>,
    );
    expect(result.tasks[0].retries).toBe(0);
    expect(result.tasks[0].retryPolicy).toBeUndefined();
  });
});

describe("Workflow component", () => {
  test("renders with name", async () => {
    const result = await render(
      <Workflow name="test">
        <Task id="t1" output="out">
          {{ v: 1 }}
        </Task>
      </Workflow>,
    );
    expect(result.xml).not.toBeNull();
    if (result.xml?.kind === "element") {
      expect(result.xml.tag).toBe("smithers:workflow");
      expect(result.xml.props.name).toBe("test");
    }
  });
});

describe("Sequence component", () => {
  test("renders children in order", async () => {
    const result = await render(
      <Sequence>
        <Task id="a" output="out">
          {{ v: 1 }}
        </Task>
        <Task id="b" output="out">
          {{ v: 2 }}
        </Task>
      </Sequence>,
    );
    expect(result.tasks[0].nodeId).toBe("a");
    expect(result.tasks[1].nodeId).toBe("b");
    expect(result.tasks[0].ordinal).toBeLessThan(result.tasks[1].ordinal);
  });

  test("skipIf returns null", async () => {
    const result = await render(
      <Workflow name="test">
        <Sequence skipIf>
          <Task id="a" output="out">
            {{ v: 1 }}
          </Task>
        </Sequence>
      </Workflow>,
    );
    expect(result.tasks).toHaveLength(0);
  });
});

describe("Parallel component", () => {
  test("renders children", async () => {
    const result = await render(
      <Parallel>
        <Task id="a" output="out">
          {{ v: 1 }}
        </Task>
        <Task id="b" output="out">
          {{ v: 2 }}
        </Task>
      </Parallel>,
    );
    expect(result.tasks).toHaveLength(2);
  });

  test("passes maxConcurrency", async () => {
    const result = await render(
      <Parallel maxConcurrency={3}>
        <Task id="a" output="out">
          {{ v: 1 }}
        </Task>
      </Parallel>,
    );
    expect(result.tasks[0].parallelMaxConcurrency).toBe(3);
  });

  test("skipIf returns null", async () => {
    const result = await render(
      <Workflow name="test">
        <Parallel skipIf>
          <Task id="a" output="out">
            {{ v: 1 }}
          </Task>
        </Parallel>
      </Workflow>,
    );
    expect(result.tasks).toHaveLength(0);
  });
});

describe("Branch component", () => {
  test("renders then branch when condition is true", async () => {
    const result = await render(
      <Workflow name="test">
        <Branch
          if={true}
          then={
            <Task id="yes" output="out">
              {{ v: 1 }}
            </Task>
          }
          else={
            <Task id="no" output="out">
              {{ v: 0 }}
            </Task>
          }
        />
      </Workflow>,
    );
    expect(result.tasks.map((t) => t.nodeId)).toContain("yes");
    expect(result.tasks.map((t) => t.nodeId)).not.toContain("no");
  });

  test("renders else branch when condition is false", async () => {
    const result = await render(
      <Workflow name="test">
        <Branch
          if={false}
          then={
            <Task id="yes" output="out">
              {{ v: 1 }}
            </Task>
          }
          else={
            <Task id="no" output="out">
              {{ v: 0 }}
            </Task>
          }
        />
      </Workflow>,
    );
    expect(result.tasks.map((t) => t.nodeId)).toContain("no");
    expect(result.tasks.map((t) => t.nodeId)).not.toContain("yes");
  });

  test("renders nothing when condition false and no else", async () => {
    const result = await render(
      <Workflow name="test">
        <Branch
          if={false}
          then={
            <Task id="yes" output="out">
              {{ v: 1 }}
            </Task>
          }
        />
      </Workflow>,
    );
    expect(result.tasks).toHaveLength(0);
  });

  test("skipIf returns null", async () => {
    const result = await render(
      <Workflow name="test">
        <Branch
          skipIf
          if={true}
          then={
            <Task id="yes" output="out">
              {{ v: 1 }}
            </Task>
          }
        />
      </Workflow>,
    );
    expect(result.tasks).toHaveLength(0);
  });
});

describe("Loop/Ralph component", () => {
  test("Loop renders ralph tag", async () => {
    const result = await render(
      <Loop id="myLoop" until={false}>
        <Task id="t1" output="out">
          {{ v: 1 }}
        </Task>
      </Loop>,
    );
    expect(result.tasks[0].ralphId).toBe("myLoop");
  });

  test("Ralph is alias for Loop", () => {
    expect(Ralph).toBe(Loop);
  });

  test("skipIf returns null", async () => {
    const result = await render(
      <Workflow name="test">
        <Loop id="loop" until={false} skipIf>
          <Task id="t1" output="out">
            {{ v: 1 }}
          </Task>
        </Loop>
      </Workflow>,
    );
    expect(result.tasks).toHaveLength(0);
  });
});

describe("MergeQueue component", () => {
  test("defaults concurrency to 1", async () => {
    const result = await render(
      <MergeQueue>
        <Task id="t1" output="out">
          {{ v: 1 }}
        </Task>
      </MergeQueue>,
    );
    expect(result.tasks[0].parallelMaxConcurrency).toBe(1);
  });

  test("custom concurrency", async () => {
    const result = await render(
      <MergeQueue maxConcurrency={3}>
        <Task id="t1" output="out">
          {{ v: 1 }}
        </Task>
      </MergeQueue>,
    );
    expect(result.tasks[0].parallelMaxConcurrency).toBe(3);
  });

  test("skipIf returns null", async () => {
    const result = await render(
      <Workflow name="test">
        <MergeQueue skipIf>
          <Task id="t1" output="out">
            {{ v: 1 }}
          </Task>
        </MergeQueue>
      </Workflow>,
    );
    expect(result.tasks).toHaveLength(0);
  });
});

describe("Worktree component", () => {
  test("throws on empty path", () => {
    expect(() =>
      Worktree({ path: "", children: null } as any),
    ).toThrow("non-empty path");
  });

  test("throws on whitespace-only path", () => {
    expect(() =>
      Worktree({ path: "   ", children: null } as any),
    ).toThrow("non-empty path");
  });

  test("skipIf returns null", () => {
    const result = Worktree({ path: "/tmp/wt", skipIf: true } as any);
    expect(result).toBeNull();
  });
});

describe("Approval component", () => {
  test("approvalDecisionSchema validates correct data", () => {
    const valid = {
      approved: true,
      note: "looks good",
      decidedBy: "alice",
      decidedAt: "2024-01-01T00:00:00.000Z",
    };
    const result = approvalDecisionSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  test("approvalDecisionSchema accepts null fields", () => {
    const valid = {
      approved: false,
      note: null,
      decidedBy: null,
      decidedAt: null,
    };
    const result = approvalDecisionSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  test("approvalDecisionSchema rejects invalid decidedAt", () => {
    const invalid = {
      approved: true,
      note: null,
      decidedBy: null,
      decidedAt: "not-a-date",
    };
    const result = approvalDecisionSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  test("renders as compute task with approval flags", async () => {
    const result = await render(
      <Approval
        id="approve-deploy"
        output="approval_out"
        request={{ title: "Deploy to prod?" }}
      />,
    );
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].nodeId).toBe("approve-deploy");
    expect(result.tasks[0].needsApproval).toBe(true);
    expect(result.tasks[0].approvalMode).toBe("decision");
  });

  test("skipIf returns null", async () => {
    const result = await render(
      <Workflow name="test">
        <Approval
          id="a"
          output="out"
          request={{ title: "t" }}
          skipIf
        />
      </Workflow>,
    );
    expect(result.tasks).toHaveLength(0);
  });
});
