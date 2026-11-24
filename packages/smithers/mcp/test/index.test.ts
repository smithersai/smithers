/**
 * The package's root entry.
 *
 * `@smthrs/mcp` is published, and `exports["."]` names `src/index.ts`, so a
 * missing barrel makes `import "@smthrs/mcp"` fail in every consumer while
 * every subpath keeps working. The release smoke caught exactly that.
 */
import { describe, expect, it } from "vitest"
import * as Mcp from "../src/index.ts"
import * as McpClient from "../src/McpClient.ts"
import * as McpFlows from "../src/McpFlows.ts"

describe("@smthrs/mcp", () => {
  it("re-exports every public module as a namespace", () => {
    expect(Object.keys(Mcp).sort()).toEqual(["Diagnostics", "McpClient", "McpError", "McpFlows"])
  })

  it("exposes the flow-binding projection the CLI composes", () => {
    // Each namespace is the module itself: a barrel that named another module, or
    // a partial copy of one, would hand the CLI different constructors.
    expect(Mcp.McpFlows.connected).toBe(McpFlows.connected)
    expect(Mcp.McpFlows.mcp).toBe(McpFlows.mcp)
    expect(Mcp.McpClient.connect).toBe(McpClient.connect)
    expect(Mcp.McpClient.HttpConnectOptionsSchema).toBe(McpClient.HttpConnectOptionsSchema)
  })
})
