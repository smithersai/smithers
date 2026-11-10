import { NodeWS } from "@effect/platform-node"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import { execFileSync, spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { admin } from "../src/internal/backend/Admin.vibe"
import { Client, esc, type Values } from "../src/internal/backend/Client.ts"
import * as ProductApi from "../src/internal/backend/ProductApi.ts"
import { resources } from "../src/internal/backend/Resources.ts"
import { runs } from "../src/internal/backend/Runs.ts"
import { quote, remote } from "../src/internal/backend/SSH.ts"
import { stacks } from "../src/internal/backend/Stack.ts"
import { workspaces, workspaceSSH } from "../src/internal/backend/Workspaces.ts"

// Fault injection is a provided Effect service at a real HTTP server boundary;
// fetch, Client, streaming, and the filesystem all run unchanged.
type Endpoint = (request: IncomingMessage, response: ServerResponse) => Promise<void>
class FaultEndpoint extends Context.Service<FaultEndpoint, Endpoint>()("test/backend/FaultEndpoint") {}
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const serve = async (endpoint: Endpoint) => {
  const home = await mkdtemp(join(tmpdir(), "smithers-backend-safety-"))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  const server = createServer((request, response) => {
    void Effect.runPromise(
      Effect.gen(function*() {
        const handle = yield* FaultEndpoint
        yield* Effect.tryPromise(() => handle(request, response))
      }).pipe(Effect.provideService(FaultEndpoint, endpoint))
    ).catch(() => response.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanup.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing HTTP address")
  const origin = `http://127.0.0.1:${address.port}`
  const environment = {
    HOME: home,
    SMITHERS_API_ORIGIN: origin,
    SMITHERS_TOKEN: "test-session",
    SMITHERS_DISABLE_SYSTEM_KEYRING: "1"
  }
  return { home, environment, origin, server, client: new Client({ environment }) }
}
const json = (response: ServerResponse, value: unknown, status = 200) => {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(value))
}

describe("export filesystem safety", () => {
  it("does not follow or delete a pre-existing predictable staging symlink", async () => {
    const { home, client } = await serve(async (_request, response) => {
      response.end("archive")
    })
    const out = join(home, "export.gz"), victim = join(home, "victim")
    await writeFile(victim, "keep")
    await symlink(victim, `${out}.partial`)
    await admin["admin user export"]!(client, { username: "alice", out }, {})
    expect(await readFile(victim, "utf8")).toBe("keep")
    expect(await readFile(out, "utf8")).toBe("archive")
    expect((await readdir(home)).sort()).toEqual(["export.gz", "export.gz.partial", "victim"])
  })

  it("publishes an owner-only archive even when replacing a readable file", async () => {
    const { home, client } = await serve(async (_request, response) => {
      response.end("private archive")
    })
    const out = join(home, "export.gz")
    await writeFile(out, "old", { mode: 0o644 })
    await admin["admin user export"]!(client, { username: "alice", out }, {})
    expect((await stat(out)).mode & 0o777).toBe(0o600)
    expect(await readFile(out, "utf8")).toBe("private archive")
  })

  it("isolates concurrent exports until each archive is atomically published", async () => {
    const gate = Promise.withResolvers<void>()
    let requests = 0
    const { home, client } = await serve(async (_request, response) => {
      if (++requests === 1) {
        response.write("first-")
        await gate.promise
        response.end("end")
      } else response.end("second")
    })
    const out = join(home, "export.gz")
    const first = admin["admin user export"]!(client, { username: "alice", out }, {})
      .then((value) => ({ value }), (error: unknown) => ({ error }))
    try {
      await expect.poll(async () => (await readdir(home)).some((name) => name.startsWith("export.gz.partial")))
        .toBe(true)
      await admin["admin user export"]!(client, { username: "alice", out }, {})
      expect(await readFile(out, "utf8")).toBe("second")
    } finally {
      gate.resolve()
    }
    expect(await first).toMatchObject({ value: { bytes: 9 } })
    expect(await readFile(out, "utf8")).toBe("first-end")
    expect(await readdir(home)).toEqual(["export.gz"])
  })

  it("keeps in-flight data private and cleans it up after a dropped connection", async () => {
    const gate = Promise.withResolvers<void>()
    const { home, client } = await serve(async (_request, response) => {
      response.write("unfinished")
      await gate.promise
      response.destroy()
    })
    const out = join(home, "export.gz")
    await writeFile(out, "previous archive")
    const running = admin["admin user export"]!(client, { username: "alice", out }, {})
      .then(() => "unexpected success", () => "failed")
    try {
      await expect.poll(async () => {
        const directory = (await readdir(home)).find((name) => name.startsWith("export.gz.partial-"))
        if (!directory) return false
        const staging = join(home, directory)
        const archive = (await readdir(staging))[0]
        if (!archive) return false
        return [(await stat(staging)).mode & 0o777, (await stat(join(staging, archive))).mode & 0o777]
      }).toEqual([0o700, 0o600])
    } finally {
      gate.resolve()
    }
    expect(await running).toBe("failed")
    expect(await readFile(out, "utf8")).toBe("previous archive")
    expect(await readdir(home)).toEqual(["export.gz"])
  })
})

const landing = async (fault: {
  readonly dismissed?: boolean
  readonly later?: "checks" | "reviews"
  readonly direct?: boolean
  readonly fallback?: boolean
  readonly checkFault?: "missing" | "short" | "limit" | "emptyLast"
}) => {
  const merges: Array<Values> = [], pages: Array<string> = []
  const fixture = await serve(async (request, response) => {
    let path = request.url!, body: Values = {}
    if (request.method === "POST") {
      let text = ""
      for await (const chunk of request) text += chunk
      body = JSON.parse(text) as Values
    }
    if (path.includes("/stacks/active")) {
      json(response, { id: "stack", changes: [{ change_id: "abc123", pr_number: 1 }] })
      return
    }
    if (path.endsWith("/github-proxy")) {
      path = String(body.path)
      body = body.body as Values ?? {}
    } else if (request.method === "PUT") {
      let text = ""
      for await (const chunk of request) text += chunk
      body = JSON.parse(text) as Values
    }
    const url = new URL(path, "http://github.local")
    if (url.pathname.endsWith("/merge")) {
      merges.push(body)
      // Simulate a head advancing after inspection: GitHub refuses the checked
      // SHA, while a request without that precondition could merge the new head.
      json(response, { message: "Head changed" }, fault.fallback && body.merge_method !== "rebase" ? 405 : 409)
    } else if (url.pathname.endsWith("/check-runs")) {
      pages.push(path)
      if (fault.checkFault === "missing") {
        json(response, {})
        return
      }
      const later = fault.later === "checks"
      const runs = later && url.searchParams.get("page") === "2"
        ? [{ name: "late failure", status: "completed", conclusion: "failure" }]
        : fault.checkFault === "emptyLast" && url.searchParams.get("page") === "2"
        ? []
        : Array.from({ length: later || ["limit", "emptyLast"].includes(fault.checkFault ?? "") ? 100 : 1 }, () => ({
          name: "CI",
          status: "completed",
          conclusion: "success"
        }))
      const total = fault.checkFault === "short"
        ? 2
        : fault.checkFault === "emptyLast"
        ? 100
        : later
        ? 101
        : runs.length
      json(response, { total_count: total, check_runs: runs })
    } else if (url.pathname.endsWith("/reviews")) {
      pages.push(path)
      const approval = { user: { login: "alice" }, state: "APPROVED" }
      json(
        response,
        fault.dismissed
          ? [approval, { user: { login: "ALICE" }, state: "DISMISSED" }]
          : fault.later === "reviews"
          ? url.searchParams.get("page") === "2"
            ? [{ user: { login: "bob" }, state: "CHANGES_REQUESTED" }]
            : Array.from({ length: 100 }, () => approval)
          : [approval]
      )
    } else json(response, { state: "open", head: { sha: "checked-head" }, mergeable: true })
  })
  const client = fault.direct ?
    new Client({
      environment: {
        ...fixture.environment,
        GITHUB_TOKEN: "test-github-token",
        SMITHERS_GITHUB_API_URL: fixture.origin
      }
    }) :
    fixture.client
  return { client, merges, pages }
}

describe("landing evidence over HTTP", () => {
  it.each([false, true])("pins every merge method to the inspected head (direct=%s)", async (direct) => {
    const f = await landing({ direct, fallback: true })
    await expect(stacks["stack land"]!(f.client, {}, { repo: "owner/repo" })).rejects.toThrow("409")
    expect(f.merges).toEqual(
      ["merge", "squash", "rebase"].map((merge_method) => ({ merge_method, sha: "checked-head" }))
    )
  })

  it("revokes an earlier approval after dismissal", async () => {
    const f = await landing({ dismissed: true })
    await expect(stacks["stack land"]!(f.client, {}, { repo: "owner/repo" })).rejects.toThrow("review is not approved")
    expect(f.merges).toEqual([])
  })

  it.each(["checks", "reviews"] as const)("reads blocking %s beyond page one", async (later) => {
    const f = await landing({ later })
    await expect(stacks["stack land"]!(f.client, {}, { repo: "owner/repo" })).rejects.toThrow(
      later === "checks" ? "CI is failing" : "review is not approved"
    )
    expect(f.pages.some((path) => path.includes("page=2"))).toBe(true)
    expect(f.merges).toEqual([])
  })

  it.each(["missing", "short", "limit"] as const)("refuses incomplete evidence (%s)", async (checkFault) => {
    const f = await landing({ checkFault })
    await expect(stacks["stack land"]!(f.client, {}, { repo: "owner/repo" })).rejects.toMatchObject({
      code: "github_protocol"
    })
    expect(f.merges).toEqual([])
  })

  it("accepts complete evidence ending at an exact page boundary", async () => {
    const f = await landing({ checkFault: "emptyLast" })
    await expect(stacks["stack land"]!(f.client, {}, { repo: "owner/repo" })).rejects.toThrow("409")
    expect(f.merges).toEqual([{ merge_method: "merge", sha: "checked-head" }])
  })
})

describe("product request destinations", () => {
  it.each([".", ".."])("rejects dot segment %s in the command encoder", (value) => {
    expect(() => esc(value)).toThrow()
  })
  it.each([".", ".."])("rejects dot segment %s before either encoder can send HTTP", async (value) => {
    const received: Array<string> = []
    const { client } = await serve(async (request, response) => {
      received.push(request.url!)
      json(response, {})
    })
    await expect((async () => ProductApi.getApiConversation(client, { path: { b: value } }))()).rejects.toThrow()
    expect(() => esc(value)).toThrow()
    expect(received).toEqual([])
  })

  it.each([ProductApi.getApiAuthAuth0Callback, ProductApi.getApiAuthGithubCallback])(
    "forwards OAuth callback code and state to the server (%s)",
    async (callback) => {
      const { client } = await serve(async (request, response) => {
        const url = new URL(request.url!, "http://local")
        json(response, Object.fromEntries(url.searchParams))
      })
      const query = { code: "code +/&?", state: "state +/&?" }
      expect(await callback(client, { query })).toEqual(query)
      const error = { state: query.state, error: "access_denied", error_description: "Denied +/ ?" }
      expect(await callback(client, { query: error })).toEqual(error)
      expect(await callback(client)).toEqual({})
    }
  )
})

const options = { repo: "owner/repo" }
const fixture = async (
  handle: (request: IncomingMessage, response: ServerResponse, body: Values) => void
) => {
  const requests: Array<{ method: string | undefined; path: string | undefined; body: Values }> = []
  const f = await serve(async (request, response) => {
    let text = ""
    for await (const chunk of request) text += chunk
    const body = text ? JSON.parse(text) as Values : {}
    requests.push({ method: request.method, path: request.url, body })
    response.setHeader("content-type", "application/json")
    handle(request, response, body)
  })
  const controller = new AbortController()
  const c = new Client({
    environment: {
      ...process.env,
      ...f.environment,
      XDG_STATE_HOME: f.home,
      SMITHERS_AUTH_FILE: join(f.home, "auth.json"),
      SMITHERS_WORKSPACE_SSH_POLL_TIMEOUT_MS: "1",
      SMITHERS_WORKSPACE_SSH_POLL_INTERVAL_MS: "1",
      ANTHROPIC_API_KEY: "sk-ant-api03-safety-test-key"
    },
    signal: controller.signal
  })
  return { ...f, c, controller, requests }
}

// A real OpenSSH server, with ephemeral host and client keys. No replacement
// executable or intercepted transport: the production SSH spawner runs ssh.
const sshServer = async (home: string, forcedCommand?: string) => {
  const key = join(home, "key")
  execFileSync("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key])
  const config = join(home, "sshd_config")
  const reservation = createServer()
  await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done))
  const address = reservation.address()
  if (!address || typeof address === "string") throw new Error("No SSH address")
  await new Promise<void>((done) => reservation.close(() => done()))
  await writeFile(
    config,
    [
      `HostKey ${key}`,
      `AuthorizedKeysFile ${key}.pub`,
      `Port ${address.port}`,
      "ListenAddress 127.0.0.1",
      `PidFile ${join(home, "sshd.pid")}`,
      "StrictModes no",
      "UsePAM no",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      ...(forcedCommand ? [`ForceCommand ${forcedCommand}`] : [])
    ].join("\n") + "\n"
  )
  const child = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", config], { stdio: ["ignore", "ignore", "pipe"] })
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill()
      await once(child, "close")
    }
  })
  await new Promise<void>((done, failed) => {
    let log = ""
    child.stderr.on("data", (data) => {
      log += data
      if (log.includes("Server listening")) done()
    })
    child.once("error", failed)
    child.once("exit", () => failed(new Error(log)))
  })
  const hostKey = (await readFile(`${key}.pub`, "utf8")).trim().split(" ").slice(0, 2).join(" ")
  const endpoint = {
    command: `ssh -p ${address.port} -i ${quote(key)} ${userInfo().username}@127.0.0.1`,
    hostKeys: [hostKey]
  }
  return { endpoint, receipt: { command: endpoint.command, host_keys: [{ known_hosts_line: hostKey }] } }
}

describe("backend safety regressions", () => {
  it("adds an assignee without replacing a concurrent assignment", async () => {
    let assignees = ["original"]
    const { c, requests } = await fixture((req, res, body) => {
      if (req.method === "GET") {
        res.end(JSON.stringify({ assignees: assignees.map((login) => ({ login })) }))
        assignees.push("concurrent")
      } else {
        // Another writer commits before this mutation reaches the server.
        if (!assignees.includes("concurrent")) assignees.push("concurrent")
        if (req.url?.endsWith("/assignees")) assignees.push(...body.assignees as string[])
        else if (body.assignees) assignees = body.assignees as string[]
        res.end("{}")
      }
    })
    await resources["issue edit"]!(c, { number: 7 }, { ...options, assignee: "new", title: "changed" })
    expect(assignees).toEqual(["original", "concurrent", "new"])
    expect(requests).toEqual([
      { method: "POST", path: "/api/repos/owner/repo/issues/7/assignees", body: { assignees: ["new"] } },
      { method: "PATCH", path: "/api/repos/owner/repo/issues/7", body: { title: "changed" } }
    ])
  })

  it.each(["dispatch", "run"])("refuses malformed workflow %s inputs before dispatch", async (action) => {
    const { c, requests } = await fixture((_req, res) => res.end("{\"workflows\":[{\"id\":7,\"name\":\"Build\"}]}"))
    for (const input of ["missing", "=value", "  =value"]) {
      await expect(
        runs[`workflow ${action}`]!(c, { id: 7, workflow: "Build" }, { ...options, input: ["ok=yes", input] })
      )
        .rejects.toMatchObject({ _tag: "/cli/UsageError" })
    }
    expect(requests).toEqual([])
  })

  it("preserves empty input values and embedded equals signs", async () => {
    const { c, requests } = await fixture((_req, res) => res.end("{}"))
    await runs["workflow dispatch"]!(c, { id: 7 }, { ...options, input: [" empty =", "value=a=b"] })
    expect(requests[0]?.body).toEqual({ ref: "main", inputs: { empty: "", value: "a=b" } })
  })

  it("cancels an artifact body without publishing or retaining a partial file", async () => {
    let storage: ServerResponse | undefined
    const f = await fixture((req, res) => {
      if (req.url === "/storage") {
        storage = res
        res.write("partial")
      } else res.end(JSON.stringify({ name: "out", download_url: `${f.origin}/storage` }))
    })
    const output = join(f.home, "out")
    await writeFile(output, "previous")
    const download = resources["artifact download"]!(f.c, { runId: 7, name: "out" }, { ...options, output })
      .then((value) => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }))
    try {
      await expect.poll(async () => (await readdir(f.home)).some((name) => name.endsWith(".partial")), {
        timeout: 10_000
      }).toBe(true)
      f.controller.abort()
      storage?.end("tail")
      const result = await download
      expect(result.error).toBeInstanceOf(Error)
      expect(result.value).toBeUndefined()
      expect(await readFile(output, "utf8")).toBe("previous")
      expect((await readdir(f.home)).some((name) => name.endsWith(".partial"))).toBe(false)
    } finally {
      storage?.end()
    }
  })

  it("surfaces a malformed SSH response immediately instead of retrying it", async () => {
    const { c, requests } = await fixture((_req, res) => res.end("invalid-json"))
    await expect(workspaceSSH(c, "box", options)).rejects.toMatchObject({
      _tag: "/cli/Refused",
      code: "backend_protocol",
      message: "API response was not valid JSON"
    })
    expect(requests).toHaveLength(1)
  })

  it("refuses credential seeding before sending a host secret to SSH", async () => {
    const f = await fixture((_req, res) => res.end(JSON.stringify(ssh.receipt)))
    const capture = join(f.home, "received")
    const ssh = await sshServer(f.home, `/bin/cat > ${quote(capture)}`)
    const result = await workspaces["workspace exec"]!(f.c, { id: "box" }, {
      ...options,
      command: "true",
      seedAgentAuth: "claude",
      detach: true
    }).then(() => undefined, (error) => error)
    expect(await readdir(f.home)).not.toContain("received")
    expect(result).toMatchObject({ code: "credential_seeding_disabled" })
    expect(f.requests).toEqual([])
  })

  it("refuses issue execution before creating a workspace or launching an unmanaged agent", async () => {
    const f = await fixture((req, res) =>
      res.end(JSON.stringify(
        req.url?.endsWith("/ssh") ? ssh.receipt : req.url?.endsWith("/issues/7") ? { title: "Fix" } : { id: "box" }
      ))
    )
    const capture = join(f.home, "commands")
    const ssh = await sshServer(f.home, `/usr/bin/printf '%s\\n' "$SSH_ORIGINAL_COMMAND" >> ${quote(capture)}`)
    const result = await workspaces["workspace issue"]!(f.c, { number: 7 }, options).then(
      () => undefined,
      (error) => error
    )
    expect(await readdir(f.home)).not.toContain("commands")
    expect(result).toMatchObject({ code: "durable_agent_required" })
    expect(f.requests).toEqual([])
  })

  it("streams SSH output without retaining copies of either channel", async () => {
    const { c, home } = await fixture((_req, res) => res.end("{}"))
    const { endpoint } = await sshServer(home)
    const bytes = 20 * 1024 * 1024
    let stdoutBytes = 0, stderrBytes = 0
    const streaming = new Client({
      ...c.runtime,
      stdout: {
        isTTY: false,
        columns: 80,
        write: (text) => {
          stdoutBytes += Buffer.byteLength(text)
          return true
        }
      },
      stderr: {
        isTTY: false,
        columns: 80,
        write: (text) => {
          stderrBytes += Buffer.byteLength(text)
          return true
        }
      }
    }, true)
    const script = `/usr/bin/python3 -c ${
      quote(
        `import sys; sys.stdout.buffer.write((b'o' * 1023 + b'\\n') * ${
          bytes / 1024
        }); sys.stderr.buffer.write((b'e' * 1023 + b'\\n') * ${bytes / 1024})`
      )
    }`
    const result = await remote(streaming, endpoint, script, 30_000, undefined, false, true)
    expect(result.code).toBe(0)
    expect(stdoutBytes).toBe(bytes)
    expect(stderrBytes).toBe(bytes)
    expect(result.stdout.length).toBe(0)
    expect(result.stderr.length).toBe(0)
  })

  it("bounds captured SSH output per channel and retains small results", async () => {
    const { c, home } = await fixture((_req, res) => res.end("{}"))
    const { endpoint } = await sshServer(home)
    const small = await remote(c, endpoint, "printf out; printf err >&2; exit 7")
    expect(small).toEqual({ code: 7, stdout: Buffer.from("out"), stderr: Buffer.from("err") })
    for (const channel of ["stdout", "stderr"]) {
      const script = `/usr/bin/python3 -c ${
        quote(`import sys; sys.${channel}.buffer.write(b'x' * (17 * 1024 * 1024))`)
      }`
      const error = await remote(c, endpoint, script).then(() => undefined, (error: unknown) => error)
      expect(error).toMatchObject({ code: "tool_output_too_large" })
    }
  })

  it("honors terminal cancellation while the WebSocket is connecting and destroys the session", async () => {
    const f = await fixture((_req, res) => res.end("{\"id\":\"terminal\"}"))
    const wss = new NodeWS.WebSocketServer({ noServer: true })
    cleanup.push(async () => {
      await new Promise<void>((done) => wss.close(() => done()))
    })
    f.server.on("upgrade", (req, socket, head) => {
      f.controller.abort()
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.send(JSON.stringify({ type: "status", status: "stopped" }))
      })
    })
    const result = await workspaces["workspace shell"]!(f.c, { id: "box" }, options).then(
      () => undefined,
      (error) => error
    )
    expect(f.requests.at(-1)?.path).toBe("/api/repos/owner/repo/workspace/sessions/terminal/destroy")
    expect(result).toMatchObject({ code: "interrupted" })
  })
})
