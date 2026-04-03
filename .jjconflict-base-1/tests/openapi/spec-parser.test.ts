// ---------------------------------------------------------------------------
// Spec parsing and operation extraction tests
// ---------------------------------------------------------------------------

import { describe, test, expect } from "bun:test";
import { extractOperations, loadSpecSync } from "../../src/openapi/spec-parser";
import { petStoreSpec, refSpec, noOperationIdSpec } from "./fixtures";

describe("loadSpecSync", () => {
  test("loads spec from object", () => {
    const spec = loadSpecSync(petStoreSpec);
    expect(spec.openapi).toBe("3.0.0");
    expect(spec.info.title).toBe("Pet Store");
  });

  test("loads spec from JSON string", () => {
    const json = JSON.stringify(petStoreSpec);
    const spec = loadSpecSync(json);
    expect(spec.openapi).toBe("3.0.0");
    expect(spec.info.title).toBe("Pet Store");
  });

  test("throws on invalid input", () => {
    expect(() => loadSpecSync("not valid json or yaml")).toThrow();
  });
});

describe("extractOperations", () => {
  test("extracts all operations from petstore spec", () => {
    const ops = extractOperations(petStoreSpec);
    expect(ops.length).toBe(4);

    const opIds = ops.map((o) => o.operationId);
    expect(opIds).toContain("listPets");
    expect(opIds).toContain("createPet");
    expect(opIds).toContain("getPet");
    expect(opIds).toContain("deletePet");
  });

  test("extracts correct method and path", () => {
    const ops = extractOperations(petStoreSpec);
    const listPets = ops.find((o) => o.operationId === "listPets")!;
    expect(listPets.method).toBe("get");
    expect(listPets.path).toBe("/pets");
    expect(listPets.summary).toBe("List all pets");

    const createPet = ops.find((o) => o.operationId === "createPet")!;
    expect(createPet.method).toBe("post");
    expect(createPet.path).toBe("/pets");
  });

  test("extracts parameters", () => {
    const ops = extractOperations(petStoreSpec);
    const listPets = ops.find((o) => o.operationId === "listPets")!;
    expect(listPets.parameters.length).toBe(2);
    expect(listPets.parameters[0]!.name).toBe("limit");
    expect(listPets.parameters[0]!.in).toBe("query");
  });

  test("extracts request body", () => {
    const ops = extractOperations(petStoreSpec);
    const createPet = ops.find((o) => o.operationId === "createPet")!;
    expect(createPet.requestBody).toBeDefined();
    const jsonSchema =
      createPet.requestBody?.content["application/json"]?.schema;
    expect(jsonSchema).toBeDefined();
  });

  test("resolves $ref in request body", () => {
    const ops = extractOperations(refSpec);
    const createPet = ops.find((o) => o.operationId === "createPet")!;
    expect(createPet.requestBody).toBeDefined();
  });

  test("generates operationId when missing", () => {
    const ops = extractOperations(noOperationIdSpec);
    expect(ops.length).toBe(1);
    expect(ops[0]!.operationId).toBe("get_items_id");
  });

  test("extracts path parameters", () => {
    const ops = extractOperations(petStoreSpec);
    const getPet = ops.find((o) => o.operationId === "getPet")!;
    expect(getPet.parameters.length).toBe(1);
    expect(getPet.parameters[0]!.name).toBe("petId");
    expect(getPet.parameters[0]!.in).toBe("path");
    expect(getPet.parameters[0]!.required).toBe(true);
  });

  test("handles empty paths", () => {
    const ops = extractOperations({
      openapi: "3.0.0",
      info: { title: "Empty", version: "1.0.0" },
      paths: {},
    });
    expect(ops.length).toBe(0);
  });
});
