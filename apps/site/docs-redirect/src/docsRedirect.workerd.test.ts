import { afterEach, expect, test } from "bun:test"
import { type ChildProcess, spawn } from "node:child_process"

// The Node host runs Miniflare, which runs workerd. It leads its own process
// group, and teardown kills the group: a timed-out test stops awaiting the
// host, and without this both Node and workerd outlive the run.
let host: ChildProcess | undefined
afterEach(async () => {
  const child = host
  host = undefined
  if (child?.pid === undefined) return
  const exited = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolve) => child.once("exit", () => resolve()))
  try {
    process.kill(-child.pid, "SIGKILL")
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause
  }
  await exited
})

const text = async (stream: NodeJS.ReadableStream): Promise<string> => {
  let output = ""
  for await (const chunk of stream) output += String(chunk)
  return output
}

// workerd, not Bun: it refuses a main module with non-handler named exports,
// which a Bun-only test cannot see (src/worker.ts).
test("workerd serves the redirect Worker: slugs answer 301, other hosts pass through", async () => {
  const bundle = await Bun.build({ entrypoints: [new URL("worker.ts", import.meta.url).pathname], target: "browser" })
  expect(bundle.success).toBe(true)
  const child = spawn("node", [new URL("../scripts/workerd.mjs", import.meta.url).pathname], {
    detached: true,
    stdio: ["pipe", "pipe", "pipe"]
  })
  host = child
  child.stdin.end(await bundle.outputs[0]!.text())
  const status = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)))
  const [output, error] = await Promise.all([text(child.stdout), text(child.stderr)])
  expect({ status: await status, error }).toEqual({ status: 0, error: "" })
  expect(output.trim()).toBe("docs redirect passed")
}, 30_000)
