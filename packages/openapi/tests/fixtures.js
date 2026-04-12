// ---------------------------------------------------------------------------
// Shared test fixtures for OpenAPI tests
// ---------------------------------------------------------------------------
export const petStoreSpec = {
    openapi: "3.0.0",
    info: { title: "Pet Store", version: "1.0.0" },
    servers: [{ url: "https://api.petstore.example.com" }],
    paths: {
        "/pets": {
            get: {
                operationId: "listPets",
                summary: "List all pets",
                parameters: [
                    {
                        name: "limit",
                        in: "query",
                        description: "Maximum number of pets to return",
                        schema: { type: "integer" },
                    },
                    {
                        name: "tag",
                        in: "query",
                        description: "Filter by tag",
                        schema: { type: "string" },
                    },
                ],
                responses: { "200": { description: "A list of pets" } },
            },
            post: {
                operationId: "createPet",
                summary: "Create a pet",
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                required: ["name"],
                                properties: {
                                    name: { type: "string", description: "The pet name" },
                                    tag: { type: "string", description: "Optional tag" },
                                },
                            },
                        },
                    },
                },
                responses: { "201": { description: "Pet created" } },
            },
        },
        "/pets/{petId}": {
            get: {
                operationId: "getPet",
                summary: "Get a pet by ID",
                parameters: [
                    {
                        name: "petId",
                        in: "path",
                        required: true,
                        description: "The pet ID",
                        schema: { type: "string" },
                    },
                ],
                responses: { "200": { description: "A pet" } },
            },
            delete: {
                operationId: "deletePet",
                summary: "Delete a pet",
                parameters: [
                    {
                        name: "petId",
                        in: "path",
                        required: true,
                        schema: { type: "string" },
                    },
                ],
                responses: { "204": { description: "Pet deleted" } },
            },
        },
    },
};
export const refSpec = {
    openapi: "3.0.0",
    info: { title: "Ref Test", version: "1.0.0" },
    servers: [{ url: "https://api.example.com" }],
    components: {
        schemas: {
            Pet: {
                type: "object",
                required: ["name"],
                properties: {
                    name: { type: "string" },
                    tag: { type: "string" },
                },
            },
            Error: {
                type: "object",
                properties: {
                    code: { type: "integer" },
                    message: { type: "string" },
                },
            },
        },
    },
    paths: {
        "/pets": {
            post: {
                operationId: "createPet",
                summary: "Create a pet",
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: { $ref: "#/components/schemas/Pet" },
                        },
                    },
                },
                responses: { "201": { description: "Pet created" } },
            },
        },
    },
};
export const noOperationIdSpec = {
    openapi: "3.0.0",
    info: { title: "No OpId", version: "1.0.0" },
    paths: {
        "/items/{id}": {
            get: {
                summary: "Get item",
                parameters: [
                    {
                        name: "id",
                        in: "path",
                        required: true,
                        schema: { type: "string" },
                    },
                ],
                responses: { "200": { description: "An item" } },
            },
        },
    },
};
export const complexSchemaSpec = {
    openapi: "3.0.0",
    info: { title: "Complex", version: "1.0.0" },
    servers: [{ url: "https://api.example.com" }],
    paths: {
        "/search": {
            post: {
                operationId: "search",
                summary: "Search items",
                parameters: [
                    {
                        name: "X-Request-Id",
                        in: "header",
                        description: "Request correlation ID",
                        schema: { type: "string" },
                    },
                ],
                requestBody: {
                    required: true,
                    content: {
                        "application/json": {
                            schema: {
                                type: "object",
                                required: ["query"],
                                properties: {
                                    query: { type: "string", description: "Search query" },
                                    filters: {
                                        type: "object",
                                        properties: {
                                            category: {
                                                type: "string",
                                                enum: ["books", "electronics", "clothing"],
                                            },
                                            minPrice: { type: "number", minimum: 0 },
                                            maxPrice: { type: "number" },
                                            inStock: { type: "boolean" },
                                        },
                                    },
                                    tags: {
                                        type: "array",
                                        items: { type: "string" },
                                        description: "Tags to filter by",
                                    },
                                    limit: {
                                        type: "integer",
                                        minimum: 1,
                                        maximum: 100,
                                        default: 10,
                                        description: "Max results",
                                    },
                                },
                            },
                        },
                    },
                },
                responses: { "200": { description: "Search results" } },
            },
        },
    },
};
