// The official Claude Code and Codex, as a person's subscription runs them (worker/personal/Agents.ts, decision 0132), in
// a real branch-sandbox container, as the person's numeric user, against the vendors' wires scripted at the network:
// each holds only a placeholder, sends it as its bearer token, never asks for another host, writes the working copy, and
// answers what `reportOf` reads. The image is built from infra/sandbox each run (Docker's cache makes an unchanged one
// quick), so a stale image never stands in for the Dockerfile. It skips only when Docker is absent.
import { execFile, spawnSync } from "node:child_process"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { sandboxImage } from "../test/sandboxImage.globalSetup.ts"
import { asPerson } from "../test/sandboxPersons.ts"
import { afterAll, beforeAll, describe, expect } from "vitest"
import * as Agents from "./Agents.ts"

const image = sandboxImage
const PLACEHOLDER = `smthrs-secret-${"cd".repeat(32)}`
/** The person's numeric user as a box maps it. `SANDBOX_TEST_USER` overrides it where rootless containers can't map that id. */
const PERSON = process.env["SANDBOX_TEST_USER"] ?? "585780777:2000"
const OWNER = PERSON.split(":")
const HOME = "/workspace/home"

const CONTAINERS = process.env["SANDBOX_TEST_ENGINE"] ?? "docker"
/** A rootless engine (Podman, Docker) can't reach the host through `host-gateway`: `SANDBOX_TEST_HOST_NETWORK=1` shares the host's network. */
const HOST_NETWORK = process.env["SANDBOX_TEST_HOST_NETWORK"] === "1"
const VENDOR_HOST = HOST_NETWORK ? "127.0.0.1" : "host.docker.internal"
const docker = (args: ReadonlyArray<string>) => spawnSync(CONTAINERS, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
const present = docker(["version", "--format", "{{.Server.Version}}"]).status === 0
/** A case run as `PERSON`: broken where the engine can't run that uid (worker/test/sandboxPersons.ts). */
const personTest = asPerson(CONTAINERS, PERSON, present)

const must = (args: ReadonlyArray<string>) => {
  const run = docker(args)
  if (run.status !== 0) throw new Error(`docker ${args[0]} failed (${run.status}): ${(run.stdout + run.stderr).slice(-4000)}`)
  return run.stdout
}

interface Seen {
  readonly method: string
  readonly url: string
  readonly authorization: string | undefined
}

const seen: Array<Seen> = []

const sse = (events: ReadonlyArray<Record<string, unknown>>) =>
  events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("")

const anthropic = (content: ReadonlyArray<Record<string, unknown>>, stop: string) =>
  sse([
    {
      type: "message_start",
      message: { id: "m", type: "message", role: "assistant", content: [], model: "claude", stop_reason: null, usage: { input_tokens: 7, output_tokens: 0 } },
    },
    ...content.flatMap((block, index) => [
      { type: "content_block_start", index, content_block: block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} } },
      {
        type: "content_block_delta",
        index,
        delta: block.type === "text"
          ? { type: "text_delta", text: block.text }
          : { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
      },
      { type: "content_block_stop", index },
    ]),
    { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ])

/** Claude's scripted turn: write a file, then answer once the tool's result comes back. */
const answerClaude = (body: string, response: ServerResponse) => {
  const wrote = body.includes("tool_result")
  response.writeHead(200, { "content-type": "text/event-stream" })
  response.end(
    wrote
      ? anthropic([{ type: "text", text: "Wrote the file." }], "end_turn")
      : anthropic(
        [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "/workspace/repo/claude.txt", content: "from claude\n" } }],
        "tool_use",
      ),
  )
}

/** Codex's scripted turn: one message and the end of the response. */
const answerCodex = (response: ServerResponse) => {
  const item = { type: "message", role: "assistant", id: "m", content: [{ type: "output_text", text: "Codex finished." }] }
  response.writeHead(200, { "content-type": "text/event-stream" })
  response.end(sse([
    { type: "response.created", response: { id: "r" } },
    { type: "response.output_item.done", item },
    {
      type: "response.completed",
      response: { id: "r", usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } },
    },
  ]))
}

const vendor = (request: IncomingMessage, response: ServerResponse) => {
  let body = ""
  request.on("data", (chunk) => (body += String(chunk)))
  request.on("end", () => {
    seen.push({ method: request.method ?? "", url: request.url ?? "", authorization: request.headers.authorization })
    if (request.url?.startsWith("/v1/messages")) return answerClaude(body, response)
    if (request.url?.includes("/responses")) return answerCodex(response)
    response.writeHead(404).end("{}")
  })
}

describe.skipIf(!present)("a subscription's agent in a real box", () => {
  let server: Server
  let port = 0
  let id = ""

  // Asynchronous: the scripted vendor answers in this process, so a blocking spawn would starve it.
  const inBox = (environment: Readonly<Record<string, string>>, command: string, timeout = 120_000) =>
    new Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string; readonly timedOut: boolean }>(
      (resolve) => {
        const args = [
          "exec",
          "--user", PERSON,
          "--workdir", "/workspace/repo",
          "--env", `HOME=${HOME}`,
          ...Object.entries(environment).flatMap(([name, value]) => ["--env", `${name}=${value}`]),
          id,
          "bash", "-c", command,
        ]
        execFile(CONTAINERS, args, { encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 }, (failure, stdout, stderr) => {
          const code = failure === null ? 0 : typeof failure.code === "number" ? failure.code : null
          resolve({ status: code, stdout, stderr, timedOut: failure?.killed === true })
        })
      },
    )

  let owned = false
  /**
   * Makes the person's home and checkout, once, from the first case: where the engine can't map the person's uid, root
   * can't give them to it, and each case fails there as its mark expects.
   */
  const own = () => {
    if (owned) return
    must(["exec", "--user", "0:0", id, "sh", "-c", `install -d -o ${OWNER[0]} -g ${OWNER[1]} ${HOME} /workspace/repo && cd /workspace/repo && git init -q && chown -R ${OWNER[0]}:${OWNER[1]} .`])
    owned = true
  }

  beforeAll(async () => {
    server = createServer(vendor)
    await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve))
    port = (server.address() as AddressInfo).port
    id = must(["run", "-d", "--rm", ...(HOST_NETWORK ? ["--network", "host"] : ["--add-host", "host.docker.internal:host-gateway"]), image]).trim()
  }, 900_000)

  afterAll(async () => {
    if (id !== "") docker(["rm", "-f", id])
    await new Promise<void>((resolve) => server?.close(() => resolve()))
  })

  personTest("Claude Code holds a placeholder, sends it to its host alone, writes the checkout and reports", async () => {
    own()
    seen.length = 0
    const environment = Agents.environment("claude-code", PLACEHOLDER, {
      baseUrl: `http://${VENDOR_HOST}:${port}`,
      now: new Date(),
    })
    const run = await inBox(environment, Agents.commandOf("claude-code", "Write claude.txt.", undefined))
    expect(run.timedOut).toBe(false)
    expect(`${run.status}: ${run.stdout.slice(-2000)} ${run.stderr.slice(-2000)}`).toMatch(/^0: /)
    expect(Agents.reportOf("claude-code", run.stdout)).toMatchObject({ summary: "Wrote the file." })
    expect((await inBox({}, "cat claude.txt")).stdout).toBe("from claude\n")
    const messages = seen.filter((request) => request.url.startsWith("/v1/messages"))
    expect(messages.length).toBeGreaterThanOrEqual(2)
    expect(new Set(messages.map((request) => request.authorization))).toEqual(new Set([`Bearer ${PLACEHOLDER}`]))
  }, 180_000)

  personTest("Codex reads its placeholder from auth.json, sends it to its host alone and reports", async () => {
    own()
    seen.length = 0
    const environment = Agents.environment("codex", PLACEHOLDER, {
      account: { accountId: "acct-1", planType: "pro" },
      now: new Date(),
    })
    const run = await inBox(
      environment,
      Agents.commandOf("codex", "Say you finished.", undefined, `http://${VENDOR_HOST}:${port}/backend-api/codex`),
    )
    expect(run.timedOut).toBe(false)
    expect(`${run.status}: ${run.stderr.slice(-3000)}`).toMatch(/^0: /)
    expect(run.stdout.trim()).toBe("Codex finished.")
    const responses = seen.filter((request) => request.url.includes("/responses"))
    expect(responses.length).toBeGreaterThanOrEqual(1)
    expect(new Set(responses.map((request) => request.authorization))).toEqual(new Set([`Bearer ${PLACEHOLDER}`]))
  }, 180_000)
})
