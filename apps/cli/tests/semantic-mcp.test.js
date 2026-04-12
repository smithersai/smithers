import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSemanticMcpServer, } from "../src/mcp/semantic-server.js";
import { SEMANTIC_TOOL_NAMES } from "../src/mcp/semantic-tools.js";
const servers = [];
const clients = [];
afterEach(async () => {
    while (clients.length > 0) {
        const client = clients.pop();
        if (client) {
            await client.close();
        }
    }
    while (servers.length > 0) {
        const server = servers.pop();
        if (server) {
            await server.close();
        }
    }
});
describe("semantic MCP surface", () => {
    test("listTools returns the semantic tool family only", async () => {
        const server = createSemanticMcpServer({
            name: "smithers-test",
            version: "test",
        });
        servers.push(server);
        const client = new Client({
            name: "smithers-semantic-test-client",
            version: "test",
        });
        clients.push(client);
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([
            server.connect(serverTransport),
            client.connect(clientTransport),
        ]);
        const { tools } = await client.listTools();
        const names = tools.map((tool) => tool.name).sort();
        expect(names).toEqual([...SEMANTIC_TOOL_NAMES].sort());
    });
});
