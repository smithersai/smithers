import { describe, expect, test } from "bun:test";
import React from "react";
import { PassThrough } from "node:stream";
import { Voice } from "../../src/components/Voice";
import { Task } from "../../src/components/Task";
import { Workflow } from "../../src/components/Workflow";
import { Parallel } from "../../src/components/Parallel";
import { SmithersRenderer } from "../../src/dom/renderer";
import type { VoiceProvider } from "../../src/voice/types";
import { createCompositeVoice } from "../../src/voice/composite";
import type { SmithersEvent } from "../../src/SmithersEvent";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockVoice(name: string): VoiceProvider {
  return {
    name,
    async speak(input: string | NodeJS.ReadableStream) {
      const stream = new PassThrough();
      stream.end(Buffer.from("audio"));
      return stream;
    },
    async listen() {
      return "transcript";
    },
  };
}

async function renderAndExtract(element: React.ReactElement) {
  const renderer = new SmithersRenderer();
  return renderer.render(element);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("voice: e2e integration", () => {
  test("Voice component propagates provider to child tasks", async () => {
    const voice = createMockVoice("test-voice");

    const result = await renderAndExtract(
      React.createElement(
        Workflow,
        null,
        React.createElement(
          Voice,
          { provider: voice, speaker: "alloy" },
          React.createElement(Task, {
            id: "t1",
            output: "out",
            children: "prompt",
          }),
        ),
      ),
    );

    expect(result.tasks).toHaveLength(1);
    const task = result.tasks[0]!;
    expect(task.voice).toBe(voice);
    expect(task.voiceSpeaker).toBe("alloy");
  });

  test("tasks outside Voice scope have no voice provider", async () => {
    const voice = createMockVoice("test-voice");

    const result = await renderAndExtract(
      React.createElement(
        Workflow,
        null,
        React.createElement(
          Voice,
          { provider: voice },
          React.createElement(Task, {
            id: "inside",
            output: "out",
            children: "prompt",
          }),
        ),
        React.createElement(Task, {
          id: "outside",
          output: "out",
          children: "prompt",
        }),
      ),
    );

    expect(result.tasks).toHaveLength(2);
    const insideTask = result.tasks.find((t) => t.nodeId === "inside")!;
    const outsideTask = result.tasks.find((t) => t.nodeId === "outside")!;
    expect(insideTask.voice).toBe(voice);
    expect(outsideTask.voice).toBeUndefined();
  });

  test("nested Voice scopes: innermost wins", async () => {
    const outerVoice = createMockVoice("outer");
    const innerVoice = createMockVoice("inner");

    const result = await renderAndExtract(
      React.createElement(
        Workflow,
        null,
        React.createElement(
          Voice,
          { provider: outerVoice, speaker: "alloy" },
          React.createElement(Task, {
            id: "a",
            output: "out",
            children: "prompt",
          }),
          React.createElement(
            Voice,
            { provider: innerVoice, speaker: "echo" },
            React.createElement(Task, {
              id: "b",
              output: "out",
              children: "prompt",
            }),
          ),
        ),
      ),
    );

    expect(result.tasks).toHaveLength(2);
    const taskA = result.tasks.find((t) => t.nodeId === "a")!;
    const taskB = result.tasks.find((t) => t.nodeId === "b")!;
    expect(taskA.voice).toBe(outerVoice);
    expect(taskA.voiceSpeaker).toBe("alloy");
    expect(taskB.voice).toBe(innerVoice);
    expect(taskB.voiceSpeaker).toBe("echo");
  });

  test("Voice composes with Parallel", async () => {
    const voice = createMockVoice("test-voice");

    const result = await renderAndExtract(
      React.createElement(
        Workflow,
        null,
        React.createElement(
          Voice,
          { provider: voice },
          React.createElement(
            Parallel,
            null,
            React.createElement(Task, {
              id: "t1",
              output: "out",
              children: "prompt",
            }),
            React.createElement(Task, {
              id: "t2",
              output: "out",
              children: "prompt",
            }),
          ),
        ),
      ),
    );

    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0]!.voice).toBe(voice);
    expect(result.tasks[1]!.voice).toBe(voice);
    // Both should have parallel group IDs too
    expect(result.tasks[0]!.parallelGroupId).toBeDefined();
    expect(result.tasks[1]!.parallelGroupId).toBeDefined();
  });

  test("Voice without speaker only sets provider", async () => {
    const voice = createMockVoice("test-voice");

    const result = await renderAndExtract(
      React.createElement(
        Workflow,
        null,
        React.createElement(
          Voice,
          { provider: voice },
          React.createElement(Task, {
            id: "t1",
            output: "out",
            children: "prompt",
          }),
        ),
      ),
    );

    const task = result.tasks[0]!;
    expect(task.voice).toBe(voice);
    expect(task.voiceSpeaker).toBeUndefined();
  });

  test("composite voice can be used as provider", async () => {
    const speaker = createMockVoice("speaker");
    const listener = createMockVoice("listener");
    const composite = createCompositeVoice({
      input: listener,
      output: speaker,
    });

    const result = await renderAndExtract(
      React.createElement(
        Workflow,
        null,
        React.createElement(
          Voice,
          { provider: composite },
          React.createElement(Task, {
            id: "t1",
            output: "out",
            children: "prompt",
          }),
        ),
      ),
    );

    const task = result.tasks[0]!;
    expect(task.voice).toBe(composite);
    expect(task.voice!.name).toBe("composite-voice");
  });

  test("VoiceStarted event type exists in SmithersEvent union", () => {
    const event: SmithersEvent = {
      type: "VoiceStarted",
      runId: "run-1",
      nodeId: "t1",
      iteration: 0,
      operation: "speak",
      provider: "test",
      timestampMs: Date.now(),
    };
    expect(event.type).toBe("VoiceStarted");
  });

  test("VoiceFinished event type exists in SmithersEvent union", () => {
    const event: SmithersEvent = {
      type: "VoiceFinished",
      runId: "run-1",
      nodeId: "t1",
      iteration: 0,
      operation: "listen",
      provider: "test",
      durationMs: 500,
      timestampMs: Date.now(),
    };
    expect(event.type).toBe("VoiceFinished");
  });

  test("VoiceError event type exists in SmithersEvent union", () => {
    const event: SmithersEvent = {
      type: "VoiceError",
      runId: "run-1",
      nodeId: "t1",
      iteration: 0,
      operation: "speak",
      provider: "test",
      error: new Error("failed"),
      timestampMs: Date.now(),
    };
    expect(event.type).toBe("VoiceError");
  });

  test("TaskDescriptor includes voice fields", async () => {
    const voice = createMockVoice("test");
    const result = await renderAndExtract(
      React.createElement(
        Workflow,
        null,
        React.createElement(
          Voice,
          { provider: voice, speaker: "alloy" },
          React.createElement(Task, {
            id: "t1",
            output: "out",
            children: "data",
          }),
        ),
      ),
    );
    const desc = result.tasks[0]!;
    expect("voice" in desc).toBe(true);
    expect("voiceSpeaker" in desc).toBe(true);
  });
});
