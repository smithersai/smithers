import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "../../src/internal/backend/Client.ts"

type Call = [string, string, unknown?]
type Command = [string, string[], Record<string, string>]
type DocumentReply = { readonly status?: number; readonly headers?: Record<string, string>; readonly text?: string }
type Reply = { readonly status: number; readonly body: unknown }
const failure = (status: number): Reply => ({ status, body: { message: "failed" } })

/** A local endpoint and executable host; Client transport and exec always run unchanged. */
export const backendFixture = async (env: Record<string, string> = {}) => {
  const home = await mkdtemp(join(tmpdir(), "smithers-backend-"))
  const calls: Call[] = [], commands: Command[] = [], exits: number[] = []
  let reply: (method: string, path: string, body: unknown) => unknown | Promise<unknown> = () => ({})
  const replies: unknown[] = []
  let command: ((...args: Command) => string | Promise<string>) | undefined
  let launch: ((url: string) => Promise<void>) | undefined
  const browserActions: Promise<void>[] = []
  const errors: unknown[] = []
  const documents: Array<{ path: string; headers: IncomingMessage["headers"] }> = []
  let document: (request: IncomingMessage) => DocumentReply = () => ({ status: 404 })
  const accepted = new Set<string>()
  const received: Array<{ method: string; path: string; authorization: string | undefined; body: unknown }> = []
  const bodyOf = async (request: IncomingMessage) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as unknown : undefined
  }
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json")
    try {
      if (req.url?.startsWith("/docs/")) {
        documents.push({ path: req.url, headers: req.headers })
        const value = document(req)
        res.writeHead(value.status ?? 200, value.headers ?? {}).end(value.text ?? "")
        return
      }
      const body = await bodyOf(req)
      if (req.url === "/host/exec") {
        const value = body as { command: string; args: string[]; env: Record<string, string> }
        const extra = Object.fromEntries(Object.entries(value.env).filter(([key]) => key.startsWith("GIT_")))
        commands.push([value.command, value.args, extra])
        if (value.command === "browser") {
          const action = launch?.(value.args.at(-1)!) ?? Promise.resolve()
          browserActions.push(action)
          await action
          res.end(JSON.stringify({ stdout: "" }))
        } else if (command === undefined) res.end(JSON.stringify({ passthrough: true }))
        else {
          try {
            res.end(JSON.stringify({ stdout: await command(value.command, value.args, extra) }))
          } catch {
            res.end(JSON.stringify({ code: 1 }))
          }
        }
        return
      }
      calls.push(body === undefined ? [req.method!, req.url!] : [req.method!, req.url!, body])
      received.push({ method: req.method!, path: req.url!, authorization: req.headers.authorization, body })
      const expected = environment.SMITHERS_TOKEN || savedToken
      if (
        req.headers.authorization !== `token ${expected}` &&
        ![...accepted].some((token) => req.headers.authorization === `token ${token}`)
      ) {
        res.writeHead(401).end(JSON.stringify({ message: "unauthorized" }))
        return
      }
      const value = replies.length ? replies.shift() : await reply(req.method!, req.url!, body)
      if (value !== null && typeof value === "object" && "status" in value && "body" in value) {
        const response = value as Reply
        res.writeHead(response.status).end(JSON.stringify(response.body))
      } else res.end(JSON.stringify(value))
    } catch (error) {
      errors.push(error)
      res.writeHead(500).end(JSON.stringify({ message: "fixture failed" }))
    }
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("Expected a loopback port")
  const origin = `http://127.0.0.1:${address.port}`
  const bin = join(home, "bin")
  await mkdir(bin)
  // These external test programs observe the process boundary; they never replace Client.exec.
  const program = `#!${process.execPath}
import { basename } from "node:path"
import { spawnSync } from "node:child_process"
const result = await fetch(process.env.TEST_BACKEND_HOST + "/host/exec", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ command: basename(process.argv[1]), args: process.argv.slice(2), env: process.env })
}).then(r => r.json())
if (result.passthrough) {
  const child = spawnSync(basename(process.argv[1]), process.argv.slice(2), {
    env: { ...process.env, PATH: process.env.TEST_BACKEND_PATH }, stdio: "inherit"
  })
  process.exit(child.status ?? 1)
}
process.stdout.write(result.stdout ?? "")
process.exit(result.code ?? 0)
`
  for (const name of ["jj", "git", "browser"]) await writeFile(join(bin, name), program, { mode: 0o700 })
  await writeFile(join(home, "package.json"), JSON.stringify({ type: "module" }))
  const savedToken = "session-secret"
  const environment: Record<string, string | undefined> = {
    HOME: home,
    XDG_CONFIG_HOME: home,
    XDG_CACHE_HOME: home,
    SMITHERS_AUTH_FILE: join(home, "auth.json"),
    SMITHERS_API_ORIGIN: origin,
    SMITHERS_TOKEN: savedToken,
    SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
    PATH: `${bin}:${process.env.PATH}`,
    TEST_BACKEND_HOST: origin,
    TEST_BACKEND_PATH: process.env.PATH,
    BROWSER: join(bin, "browser"),
    ...env
  }
  const c = new Client({
    environment,
    exit: (code) => {
      exits.push(code)
    },
    stderr: { write: () => {}, isTTY: false, columns: 80 }
  })
  return {
    c,
    home,
    origin,
    environment,
    exits,
    errors,
    received,
    documents,
    document: (handler: typeof document) => {
      document = handler
    },
    allow: (token: string) => {
      accepted.add(token)
    },
    request: {
      calls,
      respond: (value: unknown) => {
        reply = () => value
      },
      status: (status: number) => {
        reply = () => failure(status)
      },
      enqueue(...values: unknown[]) {
        replies.push(...values)
        return this
      },
      handle: (handler: typeof reply) => {
        reply = handler
      },
      clear: () => {
        calls.length = 0
      }
    },
    exec: {
      calls: commands,
      respond: (value: string) => {
        command = () => value
      },
      handle: (handler: NonNullable<typeof command>) => {
        command = handler
      }
    },
    browser: (handler: NonNullable<typeof launch>) => {
      launch = handler
    },
    browserDone: () => Promise.all(browserActions),
    save: async (token = savedToken) => {
      await c.session.save(origin, token)
    },
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((done, failed) => server.close((error) => error ? failed(error) : done()))
      await rm(home, { recursive: true, force: true })
      if (errors.length) throw new AggregateError(errors, "Backend fixture failed")
    }
  }
}
