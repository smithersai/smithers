// ---------------------------------------------------------------------------
// End-to-end: load spec, create tools, call tool, verify HTTP request
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { createOpenApiTools, createOpenApiTool } from "../src/tool-factory";
import { petStoreSpec } from "./fixtures";

const originalFetch = globalThis.fetch;

describe("OpenAPI e2e", () => {
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    mockFetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify([
            { id: 1, name: "Fido", tag: "dog" },
            { id: 2, name: "Whiskers", tag: "cat" },
          ]),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );
    globalThis.fetch = mockFetch as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("full flow: create tools from spec object → call listPets → verify", async () => {
    const tools = await createOpenApiTools(petStoreSpec, {
      auth: { type: "bearer", token: "test-token" },
    });

    // Verify tool set
    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining(["listPets", "createPet", "getPet", "deletePet"]),
    );

    // Call the listPets tool
    const result = await (tools.listPets as any).execute({ limit: 5 });

    // Verify the HTTP request
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("https://api.petstore.example.com/pets");
    expect(url).toContain("limit=5");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer test-token",
    );

    // Verify the response
    expect(result).toEqual([
      { id: 1, name: "Fido", tag: "dog" },
      { id: 2, name: "Whiskers", tag: "cat" },
    ]);
  });

  test("full flow: create single tool → call getPet with path param", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ id: 42, name: "Buddy" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    ) as any;

    const getPet = await createOpenApiTool(petStoreSpec, "getPet", {
      baseUrl: "https://override.api.com",
    });

    const result = await (getPet as any).execute({ petId: "42" });

    expect(result).toEqual({ id: 42, name: "Buddy" });
    const [url] = (globalThis.fetch as any).mock.calls[0] as [string];
    expect(url).toContain("https://override.api.com/pets/42");
  });

  test("full flow: create tools with prefix and filter", async () => {
    const tools = await createOpenApiTools(petStoreSpec, {
      include: ["listPets", "getPet"],
      namePrefix: "store_",
    });

    expect(Object.keys(tools).sort()).toEqual(["store_getPet", "store_listPets"]);

    // Call the prefixed tool
    await (tools.store_listPets as any).execute({});
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("full flow: POST with request body", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ id: 99, name: "NewPet" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      ),
    ) as any;

    const tools = await createOpenApiTools(petStoreSpec);
    const result = await (tools.createPet as any).execute({
      body: { name: "NewPet", tag: "fish" },
    });

    expect(result).toEqual({ id: 99, name: "NewPet" });
    const [url, init] = (globalThis.fetch as any).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toContain("/pets");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      name: "NewPet",
      tag: "fish",
    });
  });

  test("tool execution error returns error object instead of throwing", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("Connection refused")),
    ) as any;

    const tools = await createOpenApiTools(petStoreSpec);
    const result = await (tools.listPets as any).execute({});

    expect(result).toHaveProperty("error", true);
    expect(result.message).toContain("Connection refused");
  });
});
