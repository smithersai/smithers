import { afterEach, describe, expect, test } from "bun:test"

/**
 * The batch seed door (readiness audit §7.9): scripts/seed-allowlist.mjs
 * issues the same identity-worker admin call apps/server's
 * POST /api/admin/allowlist forwards, batched over a file or comma list of
 * GitHub logins. Exercised as a real subprocess — it is a standalone CLI
 * entry point, not TypeScript imported into the Worker — against a local
 * loopback server standing in for the identity worker (no external network).
 */

const SCRIPT_PATH = new URL("../scripts/seed-allowlist.mjs", import.meta.url).pathname

const runScript = async (
  args: ReadonlyArray<string>,
  env: Record<string, string> = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn(["node", SCRIPT_PATH, ...args], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe"
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ])
  return { exitCode, stdout, stderr }
}

let server: ReturnType<typeof Bun.serve> | undefined

afterEach(() => {
  server?.stop(true)
  server = undefined
})

describe("seed-allowlist.mjs", () => {
  test("--dry-run previews a comma list without any credentials or network call", async () => {
    const result = await runScript(["--logins", "alice,bob,carol", "--dry-run"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("[dry-run] would add 3 login(s)")
    expect(result.stdout).toContain("add alice")
    expect(result.stdout).toContain("add bob")
    expect(result.stdout).toContain("add carol")
  })

  test("--dry-run reads a file, skipping blank lines and # comments", async () => {
    const file = `${import.meta.dir}/../scripts/.seed-test-fixture.txt`
    await Bun.write(file, "dave\n# a comment\n\neve\n")
    try {
      const result = await runScript(["--file", file, "--dry-run"])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("would add 2 login(s)")
      expect(result.stdout).toContain("add dave")
      expect(result.stdout).toContain("add eve")
    } finally {
      await Bun.$`rm -f ${file}`.quiet()
    }
  })

  test("without --dry-run and no credentials, it fails fast with an actionable message and never touches the network", async () => {
    const result = await runScript(["--logins", "alice"], { IDENTITY_UPSTREAM_URL: "", IDENTITY_ADMIN_TOKEN: "" })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("IDENTITY_UPSTREAM_URL is unset")
  })

  test("issues one allowlist admin call per login, with attribution and the admin token header", async () => {
    const received: Array<{ path: string; token: string | null; body: unknown }> = []
    server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url)
        received.push({
          path: url.pathname,
          token: request.headers.get("x-smithers-admin-token"),
          body: await request.json()
        })
        return new Response(JSON.stringify({ applied: true }), {
          status: 201,
          headers: { "content-type": "application/json" }
        })
      }
    })
    const result = await runScript(["--logins", "alice,bob", "--requester", "will"], {
      IDENTITY_UPSTREAM_URL: `http://localhost:${server.port}`,
      IDENTITY_ADMIN_TOKEN: "identity-admin-123"
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("ok   add alice")
    expect(result.stdout).toContain("ok   add bob")
    expect(received.map((r) => r.path)).toEqual(["/api/identity/admin/allowlist", "/api/identity/admin/allowlist"])
    expect(received.every((r) => r.token === "identity-admin-123")).toBe(true)
    expect(received[0]?.body).toMatchObject({ login: "alice", action: "add", requester: "will" })
    expect(received[1]?.body).toMatchObject({ login: "bob", action: "add", requester: "will" })
  })

  test("a failed upstream call is reported per login and the process exits non-zero", async () => {
    server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const body = (await request.json()) as { login: string }
        const status = body.login === "bad" ? 400 : 201
        return new Response(JSON.stringify({ applied: status === 201 }), { status })
      }
    })
    const result = await runScript(["--logins", "good,bad"], {
      IDENTITY_UPSTREAM_URL: `http://localhost:${server.port}`,
      IDENTITY_ADMIN_TOKEN: "identity-admin-123"
    })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("ok   add good")
    expect(result.stdout).toContain("FAIL add bad")
    expect(result.stderr).toContain("1/2 failed")
  })
})

test("refuses a command-line token without echoing its value", async () => {
  const result = await runScript(["--logins", "alice", "--token", "never-log-this", "--dry-run"])
  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain("Unknown argument: --token")
  expect(result.stdout + result.stderr).not.toContain("never-log-this")
})

test("bounds each identity fetch and continues after a timeout", async () => {
  const received: string[] = []
  server = Bun.serve({ port: 0, fetch: async (request) => {
    const { login } = await request.json() as { login: string }
    received.push(login)
    if (login === "slow") return new Promise<Response>(() => {})
    return Response.json({ applied: true }, { status: 201 })
  } })
  const result = await runScript(["--logins", "slow,fast", "--timeout-ms", "1000"], {
    IDENTITY_UPSTREAM_URL: `http://localhost:${server.port}`, IDENTITY_ADMIN_TOKEN: "identity-admin-123"
  })
  expect(received).toEqual(["slow", "fast"])
  expect(result.exitCode).toBe(1)
  expect(result.stdout).toContain("no response within 1000 ms")
  expect(result.stdout).toContain("ok   add fast")
})

test.each(["0", "-1", "NaN", "1.5"])("rejects invalid timeout %s", async (timeout) => {
  const result = await runScript(["--logins", "alice", "--timeout-ms", timeout, "--dry-run"])
  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain("--timeout-ms must be a positive integer")
})
