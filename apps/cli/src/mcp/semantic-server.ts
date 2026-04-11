import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  createSemanticToolDefinitions,
  type SemanticToolDefinition,
} from "./semantic-tools";

export type SemanticMcpServerOptions = {
  name?: string;
  version?: string;
};

export function registerSemanticTools(
  server: McpServer,
  toolDefinitions: SemanticToolDefinition[] = createSemanticToolDefinitions(),
) {
  for (const tool of toolDefinitions) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      },
      async (input) => tool.handler(input),
    );
  }

  return server;
}

export function createSemanticMcpServer(
  options: SemanticMcpServerOptions = {},
) {
  const server = new McpServer({
    name: options.name ?? "smithers",
    version: options.version ?? "0.0.0",
  });

  registerSemanticTools(server);
  return server;
}

export async function serveSemanticMcpServer(
  options: SemanticMcpServerOptions = {},
) {
  const server = createSemanticMcpServer(options);
  const transport = new StdioServerTransport(process.stdin, process.stdout);
  await server.connect(transport);
  return server;
}
