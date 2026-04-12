// ---------------------------------------------------------------------------
// HTTP execution tests with mock fetch
// ---------------------------------------------------------------------------
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { createOpenApiToolsSync } from "../src/tool-factory.js";
import { petStoreSpec, complexSchemaSpec } from "./fixtures.js";
// Save original fetch
const originalFetch = globalThis.fetch;
describe("OpenAPI tool execution", () => {
    let mockFetch;
    beforeEach(() => {
        mockFetch = mock(() => Promise.resolve(new Response(JSON.stringify({ id: 1, name: "Fido" }), {
            status: 200,
            headers: { "content-type": "application/json" },
        })));
        globalThis.fetch = mockFetch;
    });
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });
    test("GET request with query params", async () => {
        const tools = createOpenApiToolsSync(petStoreSpec);
        const listPets = tools.listPets;
        await listPets.execute({ limit: 10, tag: "dog" });
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [url, init] = mockFetch.mock.calls[0];
        expect(url).toContain("https://api.petstore.example.com/pets");
        expect(url).toContain("limit=10");
        expect(url).toContain("tag=dog");
        expect(init.method).toBe("GET");
    });
    test("GET request with path params", async () => {
        const tools = createOpenApiToolsSync(petStoreSpec);
        const getPet = tools.getPet;
        await getPet.execute({ petId: "abc123" });
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [url] = mockFetch.mock.calls[0];
        expect(url).toContain("/pets/abc123");
    });
    test("POST request with body", async () => {
        const tools = createOpenApiToolsSync(petStoreSpec);
        const createPet = tools.createPet;
        await createPet.execute({ body: { name: "Fido", tag: "dog" } });
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [url, init] = mockFetch.mock.calls[0];
        expect(url).toContain("/pets");
        expect(init.method).toBe("POST");
        expect(init.body).toBe(JSON.stringify({ name: "Fido", tag: "dog" }));
        expect(init.headers["Content-Type"]).toBe("application/json");
    });
    test("DELETE request", async () => {
        const tools = createOpenApiToolsSync(petStoreSpec);
        const deletePet = tools.deletePet;
        await deletePet.execute({ petId: "abc123" });
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [url, init] = mockFetch.mock.calls[0];
        expect(url).toContain("/pets/abc123");
        expect(init.method).toBe("DELETE");
    });
    test("applies bearer auth header", async () => {
        const tools = createOpenApiToolsSync(petStoreSpec, {
            auth: { type: "bearer", token: "my-token" },
        });
        const listPets = tools.listPets;
        await listPets.execute({});
        const [, init] = mockFetch.mock.calls[0];
        expect(init.headers["Authorization"]).toBe("Bearer my-token");
    });
    test("applies basic auth header", async () => {
        const tools = createOpenApiToolsSync(petStoreSpec, {
            auth: { type: "basic", username: "admin", password: "secret" },
        });
        const listPets = tools.listPets;
        await listPets.execute({});
        const [, init] = mockFetch.mock.calls[0];
        const expected = `Basic ${btoa("admin:secret")}`;
        expect(init.headers["Authorization"]).toBe(expected);
    });
    test("applies apiKey auth in header", async () => {
        const tools = createOpenApiToolsSync(petStoreSpec, {
            auth: { type: "apiKey", name: "X-API-Key", value: "key123", in: "header" },
        });
        const listPets = tools.listPets;
        await listPets.execute({});
        const [, init] = mockFetch.mock.calls[0];
        expect(init.headers["X-API-Key"]).toBe("key123");
    });
    test("applies apiKey auth in query", async () => {
        const tools = createOpenApiToolsSync(petStoreSpec, {
            auth: { type: "apiKey", name: "api_key", value: "key123", in: "query" },
        });
        const listPets = tools.listPets;
        await listPets.execute({});
        const [url] = mockFetch.mock.calls[0];
        expect(url).toContain("api_key=key123");
    });
    test("applies custom headers", async () => {
        const tools = createOpenApiToolsSync(petStoreSpec, {
            headers: { "X-Custom": "value" },
        });
        const listPets = tools.listPets;
        await listPets.execute({});
        const [, init] = mockFetch.mock.calls[0];
        expect(init.headers["X-Custom"]).toBe("value");
    });
    test("uses custom base URL", async () => {
        const tools = createOpenApiToolsSync(petStoreSpec, {
            baseUrl: "https://custom.api.com",
        });
        const listPets = tools.listPets;
        await listPets.execute({});
        const [url] = mockFetch.mock.calls[0];
        expect(url).toStartWith("https://custom.api.com");
    });
    test("handles non-JSON response", async () => {
        globalThis.fetch = mock(() => Promise.resolve(new Response("plain text response", {
            status: 200,
            headers: { "content-type": "text/plain" },
        })));
        const tools = createOpenApiToolsSync(petStoreSpec);
        const listPets = tools.listPets;
        const result = await listPets.execute({});
        expect(result).toBe("plain text response");
    });
    test("returns error info on fetch failure", async () => {
        globalThis.fetch = mock(() => Promise.reject(new Error("Network error")));
        const tools = createOpenApiToolsSync(petStoreSpec);
        const listPets = tools.listPets;
        const result = await listPets.execute({});
        expect(result).toHaveProperty("error", true);
        expect(result).toHaveProperty("message");
    });
    test("header parameters are sent as headers", async () => {
        const tools = createOpenApiToolsSync(complexSchemaSpec);
        const search = tools.search;
        await search.execute({
            "X-Request-Id": "req-123",
            body: { query: "test" },
        });
        const [, init] = mockFetch.mock.calls[0];
        expect(init.headers["X-Request-Id"]).toBe("req-123");
    });
});
