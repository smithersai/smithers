import { expect, test } from "bun:test"

test("workerd forwards a real websocket upgrade and both directions of its stream", async () => {
  const bundle = await Bun.build({ entrypoints: [new URL("edge.ts", import.meta.url).pathname], target: "browser" })
  expect(bundle.success).toBe(true)
  // Miniflare's websocket control channel requires Node's complete ws API.
  const child = Bun.spawn(["node", new URL("../scripts/cutover/edge-workerd.mjs", import.meta.url).pathname], {
    stdin: new Blob([await bundle.outputs[0]!.text()]), stdout: "pipe", stderr: "pipe"
  })
  const [status, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect({ status, error }).toEqual({ status: 0, error: "" })
  expect(output.trim()).toBe("websocket round-trip passed")
}, 30_000)
