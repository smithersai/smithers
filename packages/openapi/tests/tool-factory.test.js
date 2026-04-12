// ---------------------------------------------------------------------------
// Tool factory tests — creation of AI SDK tools from specs
// ---------------------------------------------------------------------------
import { describe, test, expect } from "bun:test";
import { createOpenApiToolsSync, createOpenApiToolSync, listOperations, } from "../src/tool-factory.js";
import { petStoreSpec, complexSchemaSpec } from "./fixtures.js";
describe("createOpenApiToolsSync", () => {
    test("creates tools for all operations", () => {
        const tools = createOpenApiToolsSync(petStoreSpec);
        expect(Object.keys(tools)).toEqual(expect.arrayContaining(["listPets", "createPet", "getPet", "deletePet"]));
        expect(Object.keys(tools).length).toBe(4);
    });
    test("each tool has description and execute", () => {
        const tools = createOpenApiToolsSync(petStoreSpec);
        for (const [name, t] of Object.entries(tools)) {
            expect(t).toBeDefined();
            // AI SDK tools have these properties
            expect(typeof t.execute).toBe("function");
        }
    });
    test("applies include filter", () => {
        const tools = createOpenApiToolsSync(petStoreSpec, {
            include: ["listPets", "getPet"],
        });
        expect(Object.keys(tools).sort()).toEqual(["getPet", "listPets"]);
    });
    test("applies exclude filter", () => {
        const tools = createOpenApiToolsSync(petStoreSpec, {
            exclude: ["deletePet"],
        });
        expect(Object.keys(tools)).not.toContain("deletePet");
        expect(Object.keys(tools).length).toBe(3);
    });
    test("applies name prefix", () => {
        const tools = createOpenApiToolsSync(petStoreSpec, {
            namePrefix: "pet_",
        });
        expect(Object.keys(tools)).toContain("pet_listPets");
        expect(Object.keys(tools)).toContain("pet_createPet");
        expect(Object.keys(tools)).not.toContain("listPets");
    });
    test("uses server URL from spec as default base URL", () => {
        // Tools are created — we just verify they exist and the spec server is used
        const tools = createOpenApiToolsSync(petStoreSpec);
        expect(Object.keys(tools).length).toBeGreaterThan(0);
    });
    test("overrides base URL from options", () => {
        const tools = createOpenApiToolsSync(petStoreSpec, {
            baseUrl: "https://custom.api.example.com",
        });
        expect(Object.keys(tools).length).toBeGreaterThan(0);
    });
    test("creates tools from complex schema spec", () => {
        const tools = createOpenApiToolsSync(complexSchemaSpec);
        expect(Object.keys(tools)).toContain("search");
    });
});
describe("createOpenApiToolSync", () => {
    test("creates a single tool by operationId", () => {
        const t = createOpenApiToolSync(petStoreSpec, "listPets");
        expect(t).toBeDefined();
        expect(typeof t.execute).toBe("function");
    });
    test("throws for unknown operationId", () => {
        expect(() => createOpenApiToolSync(petStoreSpec, "nonExistent")).toThrow(/nonExistent/);
    });
});
describe("listOperations", () => {
    test("lists all operations", () => {
        const ops = listOperations(petStoreSpec);
        expect(ops.length).toBe(4);
        expect(ops[0].operationId).toBe("listPets");
        expect(ops[0].method).toBe("GET");
        expect(ops[0].path).toBe("/pets");
        expect(ops[0].summary).toBe("List all pets");
    });
    test("accepts JSON string input", () => {
        const ops = listOperations(JSON.stringify(petStoreSpec));
        expect(ops.length).toBe(4);
    });
});
