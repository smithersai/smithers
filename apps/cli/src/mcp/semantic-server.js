import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSemanticToolDefinitions, } from "./semantic-tools.js";
/** @typedef {import("./SemanticMcpServerOptions.ts").SemanticMcpServerOptions} SemanticMcpServerOptions */
/** @typedef {import("./SemanticToolDefinition.ts").SemanticToolDefinition} SemanticToolDefinition */

/**
 * @param {McpServer} server
 * @param {SemanticToolDefinition[]} [toolDefinitions]
 */
export function registerSemanticTools(server, toolDefinitions = createSemanticToolDefinitions()) {
    for (const tool of toolDefinitions) {
        server.registerTool(tool.name, {
            description: tool.description,
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema,
            annotations: tool.annotations,
        }, async (input) => tool.handler(input));
    }
    return server;
}
/**
 * @param {SemanticMcpServerOptions} [options]
 */
export function createSemanticMcpServer(options = {}) {
    const server = new McpServer({
        name: options.name ?? "smithers",
        version: options.version ?? "0.0.0",
    });
    registerSemanticTools(server);
    return server;
}
/**
 * @param {SemanticMcpServerOptions} [options]
 */
export async function serveSemanticMcpServer(options = {}) {
    const server = createSemanticMcpServer(options);
    const transport = new StdioServerTransport(process.stdin, process.stdout);
    await server.connect(transport);
    return server;
}
