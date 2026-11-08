import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Refused, UsageError } from "../src/CliError.vibe"
import { ask } from "../src/internal/backend/AgentDocs.ts"
import { APIError, Client, object } from "../src/internal/backend/Client.ts"
import { run } from "../src/internal/backend/Process.ts"
import { resources } from "../src/internal/backend/Resources.ts"
import { workspaces } from "../src/internal/backend/Workspaces.ts"
import * as Failure from "../src/internal/Failure.ts"

const dirs: Array<string> = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
const fixture = async () => {
  const home = await mkdtemp(join(tmpdir(), "backend-refusal-"))
  dirs.push(home)
  const c = new Client({
    environment: {
      HOME: home,
      XDG_CONFIG_HOME: home,
      XDG_CACHE_HOME: home,
      SMITHERS_AUTH_FILE: join(home, "auth.json"),
      SMITHERS_API_ORIGIN: "https://api.example.test",
      SMITHERS_TOKEN: "session-secret",
      SMITHERS_DISABLE_SYSTEM_KEYRING: "1"
    },
    stderr: { write: () => true, isTTY: false, columns: 80 }
  })
  return { c, home }
}
const apiError = (status: number, message?: string) =>
  new APIError(
    status,
    message === undefined ? {} : { message },
    "GET",
    "/api/repos/owner/repo",
    new Headers({ "x-request-id": "req-7" })
  )

describe("backend HTTP failures become refusals", () => {
  it.each([
    ["text/html", "<title>403</title>403 Forbidden"],
    ["application/json", "{}"],
    ["application/json", "not JSON"],
    ["text/html", "{\"message\":\"edge refusal\",\"code\":\"forbidden\",\"class\":\"permission\"}"]
  ])("identifies an edge 403 with content type %s and body %s", async (contentType, body) => {
    const { c } = await fixture()
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 403,
          headers: { "content-type": contentType }
        })
      )
    )
    const error = await c.response("POST", "/api/issues", { body: "code snippet" }).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(APIError)
    expect(c.failure(error)).toMatchObject({
      fault: "infra",
      code: "blocked_at_edge",
      httpStatus: 403,
      message:
        `Smithers Cloud's edge blocked the request before it reached the backend, probably by content filtering (HTTP 403; ${contentType}; body: ${body})`
    })
  })

  it("serializes only bounded response metadata without response cookies or the full body", async () => {
    const { c } = await fixture()
    const body = `${"x".repeat(512)}body beyond preview${"x".repeat(512)}`
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 403,
          headers: { "content-type": "text/html", "set-cookie": "session=response-cookie-secret; HttpOnly" }
        })
      )
    )
    const error = await c.response("POST", "/api/issues").catch((error: unknown) => error)
    expect(error).toBeInstanceOf(APIError)
    const serialized = JSON.stringify(error)
    const fields = JSON.parse(serialized)
    expect(fields).toMatchObject({ contentType: "text/html", requestId: "", bodyPreview: body.slice(0, 512) })
    expect(fields).not.toHaveProperty("headers")
    expect(fields).not.toHaveProperty("body")
    expect(serialized).not.toMatch(/set-cookie|response-cookie-secret|body beyond preview/)
    expect(serialized).not.toContain("x".repeat(513))
  })

  it.each([{ message: "Only maintainers can do this" }, { code: "forbidden" }])(
    "keeps a backend JSON 403 as forbidden: %j",
    async (body) => {
      const { c } = await fixture()
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body, { status: 403 })))
      const error = await c.response("POST", "/api/issues").catch((error: unknown) => error)
      expect(c.failure(error)).toMatchObject({
        fault: "user",
        code: "forbidden",
        httpStatus: 403,
        message: "message" in body ? body.message : "Your login does not have access to this"
      })
    }
  )

  it.each(["", "<title>403</title>403 Forbidden"])("keeps a 403 with a request id as forbidden: %s", async (body) => {
    const { c } = await fixture()
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 403,
          headers: { "content-type": "text/html", "x-request-id": "req-7" }
        })
      )
    )
    const error = await c.response("POST", "/api/issues").catch((error: unknown) => error)
    expect(c.failure(error)).toMatchObject({
      fault: "user",
      code: "forbidden",
      httpStatus: 403,
      message: "Your login does not have access to this"
    })
  })

  it("identifies an empty 403 with neither content type nor request id", async () => {
    const { c } = await fixture()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 403 })))
    const error = await c.response("POST", "/api/issues").catch((error: unknown) => error)
    expect(c.failure(error)).toMatchObject({
      fault: "infra",
      code: "blocked_at_edge",
      message: expect.stringContaining("HTTP 403; unknown content type; body: empty")
    })
  })

  it("redacts and bounds the terminal-safe edge diagnostic before displaying it", async () => {
    const { c } = await fixture()
    const body = `<title>403</title>session-secret\u001b]0;owned\u0007\n${"x".repeat(400)}`
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 403,
          headers: { "content-type": "text/html" }
        })
      )
    )
    const error = await c.response("POST", "/api/issues").catch((error: unknown) => error)
    const failure = c.failure(error) as Refused
    expect(failure.code).toBe("blocked_at_edge")
    expect(failure.message).toContain("<title>403</title>[REDACTED]")
    expect(failure.message).not.toMatch(/session-secret|owned|[\u0000-\u001f\u007f]/)
    expect(failure.message.length).toBeLessThan(400)
  })

  it.each(
    [
      [401, "user", "not_signed_in"],
      [403, "user", "forbidden"],
      [404, "user", "not_found"],
      [409, "wait", "conflict"],
      [423, "wait", "locked"],
      [425, "wait", "too_early"],
      [429, "infra", "rate_limited"],
      [500, "infra", "backend_unavailable"],
      [503, "infra", "backend_unavailable"],
      [400, "user", "request_refused"],
      [422, "user", "request_refused"]
    ] as const
  )("maps HTTP %i to a %s refusal coded %s", async (status, fault, code) => {
    const { c } = await fixture()
    const failure = c.failure(apiError(status, "Repository owner/repo is archived"))
    expect(failure).toBeInstanceOf(Refused)
    expect(failure).toMatchObject({
      fault,
      code,
      message: status >= 500
        ? expect.stringContaining("Repository owner/repo is archived")
        : "Repository owner/repo is archived"
    })
    // The method, path, status, and request id are detail, never the sentence.
    expect(Failure.operatorSentence(failure)).not.toMatch(/GET|\/api\/repos|-> |req-7/)
  })

  it.each(
    [
      [401, "not_signed_in"],
      [404, "not_found"],
      [409, "conflict"],
      [423, "locked"],
      [425, "too_early"],
      [429, "rate_limited"],
      [503, "backend_unavailable"],
      [422, "request_refused"]
    ] as const
  )("keeps the status mapping for an HTML %i without a request id", async (status, code) => {
    const { c } = await fixture()
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<title>Denied</title>", {
          status,
          headers: { "content-type": "text/html" }
        })
      )
    )
    const error = await c.response("POST", "/api/issues").catch((error: unknown) => error)
    expect(c.failure(error)).toMatchObject({ code, httpStatus: status })
  })

  it.each(["permission", "never", "capacity", "github", "conflict", "infra", "user"] as const)(
    "retains the install's typed %s refusal",
    async (category) => {
      const { c } = await fixture()
      const failure = c.failure(
        new APIError(
          403,
          { class: category, code: "operation_refused", message: "Only a person can do this" },
          "POST",
          "/api/todos/1",
          new Headers()
        )
      )
      expect(failure).toMatchObject({
        class: category,
        code: "operation_refused",
        httpStatus: 403,
        message: "Only a person can do this"
      })
    }
  )

  it("states a designed sentence when the backend sent none", async () => {
    const { c } = await fixture()
    expect(c.failure(apiError(503))).toMatchObject({
      code: "backend_unavailable",
      message: expect.stringContaining("Smithers Cloud did not answer. Not your fault")
    })
    expect(c.failure(apiError(401))).toMatchObject({ code: "not_signed_in", message: expect.stringContaining("login") })
  })

  it("redacts the session's secrets and terminal controls from the backend's sentence", async () => {
    const { c } = await fixture()
    c.protect("session-secret")
    const failure = c.failure(apiError(403, "token session-secret \u001b]0;owned\u0007denied")) as Refused
    expect(failure.message).not.toContain("session-secret")
    expect(failure.message).not.toContain("\u001b")
    expect(failure.message).toContain("denied")
  })

  it("keeps a tagged failure's tag and redacts its sentence", async () => {
    const { c } = await fixture()
    c.protect("session-secret")
    const usage = new UsageError({ message: "bad value session-secret" })
    const failure = c.failure(usage)
    expect(failure).toBeInstanceOf(UsageError)
    expect((failure as UsageError).message).not.toContain("session-secret")
    const refused = new Refused({ fault: "user", code: "not_found", message: "Missing" })
    expect(c.failure(refused)).toBe(refused)
  })

  it("passes a runtime error through so the reporter prints the generic sentence", async () => {
    const { c } = await fixture()
    const bug = new TypeError("Cannot read properties of undefined (reading 'id')")
    expect(c.failure(bug)).toBe(bug)
    expect(Failure.operatorSentence(c.failure(bug))).toBe(Failure.unknownSentence)
  })
})

describe.skipIf(process.platform === "win32")("backend process failures", () => {
  it("reports a spawn the platform refused without the platform's own text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "backend-refusal-dir-"))
    dirs.push(directory)
    const failure = await run(directory, [], { env: { PATH: process.env.PATH }, timeoutMs: 10_000 }).catch((
      error: unknown
    ) => error)
    expect(failure).toBeInstanceOf(Refused)
    expect(failure).toMatchObject({ fault: "dependency", code: "tool_failed", message: `${directory} failed` })
    expect(Failure.operatorSentence(failure)).not.toMatch(/EACCES|permission denied|spawn/i)
  })

  it("reports a timeout as a refusal whose sentence names the tool", async () => {
    const failure = await run("sh", ["-c", "sleep 5"], { env: { PATH: process.env.PATH }, timeoutMs: 50 }).catch((
      error: unknown
    ) => error)
    expect(failure).toMatchObject({ _tag: "/cli/Refused", code: "tool_timed_out", message: "sh timed out" })
  })

  it("reports a failed local tool through Client.exec without its stderr", async () => {
    const { c } = await fixture()
    const failure = await c.exec("sh", ["-c", "echo secret-detail >&2; exit 4"]).catch((error: unknown) => error)
    expect(failure).toMatchObject({ fault: "dependency", code: "tool_failed", message: "sh failed" })
  })
})

describe("workspace exec reattach refusals", () => {
  it("names the reattach id and never the transport's own text", async () => {
    const { c } = await fixture()
    vi.spyOn(c, "request").mockRejectedValue(new TypeError("fetch failed: ECONNRESET 10.0.0.3:443"))
    const failure = await workspaces["workspace exec"]!(c, { id: "box" }, {
      repo: "owner/repo",
      command: "true",
      "exec-id": "retry"
    }).catch((error: unknown) => error)
    expect(failure).toMatchObject({
      fault: "infra",
      code: "exec_unconfirmed",
      message: "Lost contact with the command; reattach with --exec-id retry"
    })
    expect(Failure.operatorSentence(failure)).not.toContain("ECONNRESET")
  })

  it("keeps a backend refusal's code and adds the reattach id", async () => {
    const { c } = await fixture()
    vi.spyOn(c, "request").mockRejectedValue(apiError(429, "Too many command runs"))
    const failure = await workspaces["workspace exec"]!(c, { id: "box" }, {
      repo: "owner/repo",
      command: "true",
      "exec-id": "busy"
    }).catch((error: unknown) => error)
    expect(failure).toMatchObject({
      fault: "infra",
      code: "rate_limited",
      message: "Too many command runs; reattach with --exec-id busy"
    })
    expect(Failure.operatorSentence(failure)).not.toMatch(/GET|\/api\/repos/)
  })

  it("refuses invalid exec options as usage errors", async () => {
    const { c } = await fixture()
    await expect(workspaces["workspace exec"]!(c, { id: "box" }, { repo: "owner/repo", command: "" })).rejects
      .toBeInstanceOf(UsageError)
  })
})

describe("agent ask context fields", () => {
  it("states the backend's refusal for an unavailable repository, not the raw request line", async () => {
    const { c } = await fixture()
    vi.spyOn(c, "repo").mockReturnValue("owner/repo")
    vi.spyOn(c, "exec").mockRejectedValue(new Error("jj exploded at /private/path"))
    vi.spyOn(c, "request").mockImplementation(async (_method, path) => {
      if (path === "/api/user") return { login: "owner" }
      throw apiError(404, "Repository owner/repo was not found")
    })
    const value = object(await ask(c, {}, {}))
    const context = object(value.repo_context)
    expect(context.remoteRepo).toEqual({
      checked: true,
      available: false,
      message: "Repository owner/repo was not found"
    })
    expect(context.jjStatus).toEqual({ ok: false, error: "jj exploded at /private/path" })
  })

  it("reports a runtime failure in a context field with the generic sentence", async () => {
    const { c } = await fixture()
    vi.spyOn(c, "repo").mockReturnValue("owner/repo")
    vi.spyOn(c, "exec").mockRejectedValue(new TypeError("Cannot read properties of undefined"))
    vi.spyOn(c, "request").mockImplementation(async (_method, path) => {
      if (path === "/api/user") return { login: "owner" }
      throw new TypeError("fetch failed: getaddrinfo ENOTFOUND internal.host")
    })
    const context = object(object(await ask(c, {}, {})).repo_context)
    expect(object(context.remoteRepo).message).toBe(Failure.unknownSentence)
    expect(object(context.jjStatus).error).toBe(Failure.unknownSentence)
  })

  it("never puts a transport error's text into the docs warning", async () => {
    const { c } = await fixture()
    vi.spyOn(c, "exec").mockResolvedValue("")
    vi.spyOn(c, "repo").mockImplementation(() => {
      throw new UsageError({ message: "Expected OWNER/REPO or a clone URL" })
    })
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed: ENOTFOUND smithers.sh")))
    const value = object(await ask(c, { prompt: "anything" }, {}))
    expect(object(value.docs_status).warning).toBe("Docs refresh failed")
  })

  it("names the docs server's HTTP status as a tagged dependency refusal", async () => {
    const { c } = await fixture()
    vi.spyOn(c, "exec").mockResolvedValue("")
    vi.spyOn(c, "repo").mockImplementation(() => {
      throw new UsageError({ message: "Expected OWNER/REPO or a clone URL" })
    })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("upstream trace", { status: 503 })))
    const value = object(await ask(c, { prompt: "anything" }, {}))
    expect(object(value.docs_status).warning).toBe("Docs refresh failed: the docs server answered HTTP 503")
  })
})

describe("secret host binding refusals (#3212)", () => {
  it("states the backend's typed refusal of a wildcard or CIDR host as the user's to fix", async () => {
    for (const host of ["*.ngrok-free.app", "127.0.0.0/8"]) {
      const { c } = await fixture()
      const message =
        `secret binding host "${host}" must be an exact host name; wildcards and address ranges are refused`
      const fetch = vi.fn().mockResolvedValue(Response.json({
        code: "validation_failed",
        fault: "user",
        message,
        errors: [{ resource: "Secret", field: "hosts", code: "invalid" }]
      }, { status: 422 }))
      vi.stubGlobal("fetch", fetch)
      const error = await resources["secret bind"]!(c, { name: "DEPLOY_KEY" }, {
        repo: "owner/repo",
        host: ["api.example.com", host],
        header: ["authorization"]
      }).then(() => undefined, (cause: unknown) => cause)
      const [url, init] = fetch.mock.calls[0]!
      expect(String(url)).toBe("https://api.example.test/api/repos/owner/repo/secrets/DEPLOY_KEY")
      expect(JSON.parse(String(init.body))).toEqual({
        hosts: ["api.example.com", host],
        match_headers: ["authorization"]
      })
      const failure = c.failure(error)
      expect(failure).toBeInstanceOf(Refused)
      expect(failure).toMatchObject({ fault: "user", message })
    }
  })
})
