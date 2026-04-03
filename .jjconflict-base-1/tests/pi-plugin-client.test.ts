import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";

// We'll test the HTTP client functions by mocking global fetch
const originalFetch = globalThis.fetch;

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = handler as any;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("pi-plugin/index HTTP client", () => {
  // Import fresh each time to avoid cached module state
  async function loadClient() {
    return import("../src/pi-plugin/index");
  }

  describe("buildHeaders (via runWorkflow)", () => {
    test("sends Content-Type and Authorization when apiKey provided", async () => {
      let capturedHeaders: Record<string, string> = {};
      mockFetch(async (url, init) => {
        capturedHeaders = Object.fromEntries(
          Object.entries(init?.headers ?? {}),
        );
        return new Response(JSON.stringify({ runId: "r1" }), { status: 200 });
      });

      const client = await loadClient();
      await client.runWorkflow({
        workflowPath: "test.tsx",
        input: { prompt: "hello" },
        apiKey: "test-key",
      });

      expect(capturedHeaders["Content-Type"]).toBe("application/json");
      expect(capturedHeaders["Authorization"]).toBe("Bearer test-key");
    });

    test("omits Authorization when no apiKey", async () => {
      let capturedHeaders: Record<string, string> = {};
      mockFetch(async (url, init) => {
        capturedHeaders = Object.fromEntries(
          Object.entries(init?.headers ?? {}),
        );
        return new Response(JSON.stringify({ runId: "r1" }), { status: 200 });
      });

      const client = await loadClient();
      await client.runWorkflow({
        workflowPath: "test.tsx",
        input: {},
      });

      expect(capturedHeaders["Authorization"]).toBeUndefined();
    });
  });

  describe("runWorkflow", () => {
    test("posts to /v1/runs with correct body", async () => {
      let capturedUrl = "";
      let capturedBody: any = {};
      mockFetch(async (url, init) => {
        capturedUrl = url;
        capturedBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ runId: "r1" }), { status: 200 });
      });

      const client = await loadClient();
      await client.runWorkflow({
        workflowPath: "my-workflow.tsx",
        input: { prompt: "do stuff" },
        runId: "custom-id",
        baseUrl: "http://localhost:9999",
      });

      expect(capturedUrl).toBe("http://localhost:9999/v1/runs");
      expect(capturedBody.workflowPath).toBe("my-workflow.tsx");
      expect(capturedBody.input).toEqual({ prompt: "do stuff" });
      expect(capturedBody.runId).toBe("custom-id");
    });

    test("uses default base URL", async () => {
      let capturedUrl = "";
      mockFetch(async (url) => {
        capturedUrl = url;
        return new Response(JSON.stringify({}), { status: 200 });
      });

      const client = await loadClient();
      await client.runWorkflow({ workflowPath: "w.tsx", input: {} });
      expect(capturedUrl).toBe("http://127.0.0.1:7331/v1/runs");
    });

    test("throws on non-ok response", async () => {
      mockFetch(async () => new Response("", { status: 500 }));

      const client = await loadClient();
      await expect(
        client.runWorkflow({ workflowPath: "w.tsx", input: {} }),
      ).rejects.toThrow(/HTTP 500/);
    });
  });

  describe("resume", () => {
    test("posts with resume flag", async () => {
      let capturedBody: any = {};
      mockFetch(async (_url, init) => {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({}), { status: 200 });
      });

      const client = await loadClient();
      await client.resume({
        workflowPath: "w.tsx",
        runId: "r1",
      });

      expect(capturedBody.resume).toBe(true);
      expect(capturedBody.runId).toBe("r1");
    });
  });

  describe("approve", () => {
    test("posts to correct approve endpoint", async () => {
      let capturedUrl = "";
      let capturedBody: any = {};
      mockFetch(async (url, init) => {
        capturedUrl = url;
        capturedBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({}), { status: 200 });
      });

      const client = await loadClient();
      await client.approve({
        runId: "r1",
        nodeId: "gate-1",
        iteration: 2,
        note: "looks good",
        baseUrl: "http://localhost:8080",
      });

      expect(capturedUrl).toBe("http://localhost:8080/v1/runs/r1/nodes/gate-1/approve");
      expect(capturedBody.iteration).toBe(2);
      expect(capturedBody.note).toBe("looks good");
    });

    test("defaults iteration to 0", async () => {
      let capturedBody: any = {};
      mockFetch(async (_url, init) => {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({}), { status: 200 });
      });

      const client = await loadClient();
      await client.approve({ runId: "r1", nodeId: "n1" });
      expect(capturedBody.iteration).toBe(0);
    });
  });

  describe("deny", () => {
    test("posts to correct deny endpoint", async () => {
      let capturedUrl = "";
      mockFetch(async (url) => {
        capturedUrl = url;
        return new Response(JSON.stringify({}), { status: 200 });
      });

      const client = await loadClient();
      await client.deny({ runId: "r1", nodeId: "gate-1" });
      expect(capturedUrl).toBe("http://127.0.0.1:7331/v1/runs/r1/nodes/gate-1/deny");
    });
  });

  describe("cancel", () => {
    test("posts to cancel endpoint", async () => {
      let capturedUrl = "";
      mockFetch(async (url) => {
        capturedUrl = url;
        return new Response(JSON.stringify({}), { status: 200 });
      });

      const client = await loadClient();
      await client.cancel({ runId: "r1" });
      expect(capturedUrl).toBe("http://127.0.0.1:7331/v1/runs/r1/cancel");
    });
  });

  describe("getStatus", () => {
    test("fetches run status with GET", async () => {
      let capturedUrl = "";
      let capturedMethod = "";
      mockFetch(async (url, init) => {
        capturedUrl = url;
        capturedMethod = init?.method ?? "GET";
        return new Response(JSON.stringify({ status: "running" }), { status: 200 });
      });

      const client = await loadClient();
      const result = await client.getStatus({ runId: "r1" });
      expect(capturedUrl).toBe("http://127.0.0.1:7331/v1/runs/r1");
      expect(capturedMethod).toBe("GET");
      expect(result.status).toBe("running");
    });

    test("throws on error response", async () => {
      mockFetch(async () => new Response("", { status: 404 }));
      const client = await loadClient();
      await expect(client.getStatus({ runId: "r1" })).rejects.toThrow(/HTTP 404/);
    });
  });

  describe("getFrames", () => {
    test("fetches frames with limit", async () => {
      let capturedUrl = "";
      mockFetch(async (url) => {
        capturedUrl = url;
        return new Response(JSON.stringify([]), { status: 200 });
      });

      const client = await loadClient();
      await client.getFrames({ runId: "r1", tail: 5 });
      expect(capturedUrl).toBe("http://127.0.0.1:7331/v1/runs/r1/frames?limit=5");
    });

    test("defaults limit to 20", async () => {
      let capturedUrl = "";
      mockFetch(async (url) => {
        capturedUrl = url;
        return new Response(JSON.stringify([]), { status: 200 });
      });

      const client = await loadClient();
      await client.getFrames({ runId: "r1" });
      expect(capturedUrl).toBe("http://127.0.0.1:7331/v1/runs/r1/frames?limit=20");
    });
  });

  describe("listRuns", () => {
    test("fetches runs with query params", async () => {
      let capturedUrl = "";
      mockFetch(async (url) => {
        capturedUrl = url;
        return new Response(JSON.stringify([]), { status: 200 });
      });

      const client = await loadClient();
      await client.listRuns({ limit: 10, status: "running" });
      expect(capturedUrl).toContain("limit=10");
      expect(capturedUrl).toContain("status=running");
    });

    test("fetches runs without query params", async () => {
      let capturedUrl = "";
      mockFetch(async (url) => {
        capturedUrl = url;
        return new Response(JSON.stringify([]), { status: 200 });
      });

      const client = await loadClient();
      await client.listRuns();
      expect(capturedUrl).toBe("http://127.0.0.1:7331/v1/runs");
    });
  });

  describe("streamEvents", () => {
    test("parses SSE data lines", async () => {
      const sseBody = [
        "data: " + JSON.stringify({ type: "RunStarted", runId: "r1" }),
        "",
        "data: " + JSON.stringify({ type: "NodeStarted", nodeId: "n1" }),
        "",
        "",
      ].join("\n");

      mockFetch(async () => {
        return new Response(sseBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      });

      const client = await loadClient();
      const events: any[] = [];
      for await (const event of client.streamEvents({ runId: "r1" })) {
        events.push(event);
      }

      expect(events.length).toBe(2);
      expect(events[0].type).toBe("RunStarted");
      expect(events[1].type).toBe("NodeStarted");
    });

    test("returns empty on non-ok response", async () => {
      mockFetch(async () => new Response("", { status: 404 }));

      const client = await loadClient();
      const events: any[] = [];
      for await (const event of client.streamEvents({ runId: "r1" })) {
        events.push(event);
      }
      expect(events.length).toBe(0);
    });
  });
});
