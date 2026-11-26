import { createServer } from "node:http"
import { expect, test } from "vitest"
import { redeem } from "../src/commands/AttachCommand.ts"

test.each([
  ["missing path", {}],
  ["foreign origin", { mcpPath: "https://other.example/mcp/acme/project/main" }],
  ["network-path reference", { mcpPath: "//other.example/mcp/acme/project/main" }],
  ["unscoped path", { mcpPath: "/mcp" }]
])("attach refuses an agent grant with %s", async (_description, path) => {
  const server = createServer((request, response) => {
    const body = request.url === "/api/attach/claim"
      ? { claim: "claim", pairing: "123456" }
      : { token: "smat_agent", grant: { act: "agent", expiresAt: Date.now() + 60_000 }, ...path }
    request.resume()
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body))
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  try {
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("Expected a TCP address")
    await expect(redeem({
      intent: "ABCD-EFGH",
      origin: "http://127.0.0.1:" + address.port,
      approve: async () => "code"
    })).rejects.toThrow(/Invalid/)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
