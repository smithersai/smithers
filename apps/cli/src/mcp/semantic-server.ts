import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type SemanticToolDefinition } from "./semantic-tools";
export type SemanticMcpServerOptions = {
    name?: string;
    version?: string;
};
export declare function registerSemanticTools(server: McpServer, toolDefinitions?: SemanticToolDefinition[]): McpServer;
export declare function createSemanticMcpServer(options?: SemanticMcpServerOptions): McpServer;
export declare function serveSemanticMcpServer(options?: SemanticMcpServerOptions): Promise<McpServer>;
