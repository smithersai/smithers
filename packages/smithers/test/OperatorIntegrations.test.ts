import { Redacted } from "effect"
import * as Fs from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import * as Presentation from "../src/cli/Presentation.ts"
import { withCredentials } from "../src/operator/Credentials.ts"
import { createIntegrationsCli, probe, readIntegrations } from "../src/operator/Integrations.ts"

const directories: Array<string> = []
const closers: Array<() => Promise<void>> = []
afterAll(async () => {
  await Promise.all(directories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(closers.splice(0).map((close) => close()))
})

/** One request a GitHub stand-in received. */
interface Received {
  readonly path: string
  readonly authorization: string | undefined
}

/**
 * A real HTTP server on loopback standing in for the GitHub API. The probe
 * reaches it over the real fetch transport; nothing intercepts a request.
 */
const github = async (answer: { status: number; body: unknown } = {
  status: 200,
  body: { resources: { core: { remaining: 5000 } } }
}) => {
  const requests: Array<Received> = []
  const state = { answer }
  const server = createServer((request, response) => {
    requests.push({ path: request.url ?? "/", authorization: request.headers.authorization })
    response.writeHead(state.answer.status, { "content-type": "application/json" })
    response.end(JSON.stringify(state.answer.body))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  closers.push(() =>
    new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  )
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, state }
}
const root = async () => {
  vi.stubEnv("SMITHERS_REMOTE", "")
  const directory = await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-integration-cli-"))
  directories.push(directory)
  await Fs.mkdir(Path.join(directory, ".smithers"))
  return directory
}
const serve = async (root: string, args: ReadonlyArray<string>) => {
  let code = 0
  let output = ""
  await createIntegrationsCli().serve([...args, "--root", root, "--json"], {
    exit: (value) => {
      code = value
    },
    stdout: (value) => {
      output += value
    }
  })
  return { code, output, data: JSON.parse(output) }
}

describe("integration CLI", () => {
  it("discovers fallback credentials without exposing values", async () => {
    const directory = await root()
    expect(readIntegrations(directory, undefined, {})).toEqual([])
    expect(readIntegrations(directory, undefined, { GITHUB_TOKEN: "fallback-fixture" })).toEqual([
      { id: "github", provider: "github", tokenEnv: "GITHUB_TOKEN" }
    ])
    expect(readIntegrations(directory, undefined, {
      SMITHERS_GITHUB_TOKEN: "preferred-fixture",
      GITHUB_TOKEN: "fallback-fixture",
      SMITHERS_TELEGRAM_BOT_TOKEN: "telegram-fixture"
    })).toEqual([
      { id: "github", provider: "github", tokenEnv: "SMITHERS_GITHUB_TOKEN" }
    ])
    expect(() => readIntegrations(directory, "missing.json", {})).toThrow("configuration does not exist")
  })

  it.each([
    "ftp://example.invalid",
    "http://example.invalid",
    "https://user:private-fixture@example.invalid",
    "https://example.invalid?token=private-fixture",
    "https://example.invalid#private-fixture"
  ])("refuses unsafe provider endpoint %s without echoing its credentials", async (apiBaseUrl) => {
    const directory = await root()
    await Fs.writeFile(
      Path.join(directory, ".smithers/integrations.json"),
      JSON.stringify({
        version: 1,
        integrations: [{ id: "gh", provider: "github", apiBaseUrl }]
      })
    )
    const result = await serve(directory, ["list"])
    expect(result.code).toBe(1)
    expect(result.output).toContain("API endpoint must be HTTP(S)")
    expect(result.output).not.toContain("private-fixture")
  })

  it("refuses a configuration whose root is not an object", async () => {
    const directory = await root()
    await Fs.writeFile(Path.join(directory, ".smithers/integrations.json"), "null")
    const result = await serve(directory, ["list"])
    expect(result.code).toBe(1)
    expect(result.output).toContain("Invalid integrations configuration: (root) is invalid")
  })

  it("refuses duplicate IDs and contradictory credential sources", async () => {
    const directory = await root()
    const config = Path.join(directory, ".smithers/integrations.json")
    await Fs.writeFile(
      config,
      JSON.stringify({
        version: 1,
        integrations: [{ id: "same", provider: "github" }, { id: "same", provider: "github" }]
      })
    )
    expect(() => readIntegrations(directory)).toThrow("Integration IDs must be unique")
    await Fs.writeFile(
      config,
      JSON.stringify({
        version: 1,
        integrations: [{ id: "gh", provider: "github", tokenEnv: "TOKEN", credentialId: "stored" }]
      })
    )
    expect(() => readIntegrations(directory)).toThrow("Use tokenEnv or credentialId, not both")
  })

  it("refuses malformed configuration by path, never quoting the value or the parser's text", async () => {
    const directory = await root()
    const config = Path.join(directory, ".smithers/integrations.json")
    await Fs.writeFile(
      config,
      JSON.stringify({ version: 1, integrations: [{ id: "gh", provider: "ghp_private-fixture-token" }] })
    )
    let refusal: unknown
    try {
      readIntegrations(directory)
    } catch (error) {
      refusal = error
    }
    expect(refusal).toMatchObject({
      _tag: "/cli/Refused",
      fault: "user",
      code: "operator_failed",
      message: "Invalid integrations configuration: integrations.0.provider is invalid"
    })
    await Fs.writeFile(config, "{ \"version\": 1, ghp_private-fixture-token")
    expect(() => readIntegrations(directory)).toThrow(".smithers/integrations.json is not valid JSON")
    const listed = await serve(directory, ["list"])
    expect(listed.code).toBe(1)
    expect(listed.output).toContain("operator_failed")
    expect(listed.output).not.toContain("private-fixture-token")
  })

  it("checks every provider's default credential offline without sending requests", async () => {
    const directory = await root()
    const upstream = await github()
    vi.stubEnv("SMITHERS_GITHUB_API_BASE_URL", upstream.origin)
    await Fs.writeFile(
      Path.join(directory, ".smithers/integrations.json"),
      JSON.stringify({ version: 1, integrations: [{ id: "github", provider: "github", apiBaseUrl: upstream.origin }] })
    )
    for (const name of ["SMITHERS_GITHUB_TOKEN"]) {
      vi.stubEnv(name, "provider-fixture-secret")
    }
    const result = await serve(directory, ["doctor", "--offline"])
    expect(result.code, result.output).toBe(0)
    expect(result.data).toEqual({
      healthy: true,
      integrations: [{ id: "github", provider: "github", healthy: true, check: "credential-present" }]
    })
    expect(upstream.requests).toEqual([])
    expect(result.output).not.toContain("provider-fixture-secret")
  })

  it("refuses unrelated stored credentials even at a host-authorized provider", async () => {
    const directory = await root()
    const upstream = await github()
    vi.stubEnv("SMITHERS_CREDENTIAL_KEY", Buffer.alloc(32, 9).toString("base64"))
    vi.stubEnv("SMITHERS_GITHUB_API_BASE_URL", upstream.origin)
    vi.stubEnv("SMITHERS_GITHUB_CREDENTIAL_IDS", " github-token, another-github-token ")
    await withCredentials({ root: directory }, (service) =>
      service.create({
        id: "unrelated-token",
        name: "Unrelated production service",
        secret: Redacted.make("unrelated-fixture-secret")
      }), true)
    const entry = {
      id: "borrowed",
      provider: "github" as const,
      credentialId: "unrelated-token",
      apiBaseUrl: upstream.origin
    }
    await Fs.writeFile(
      Path.join(directory, ".smithers/integrations.json"),
      JSON.stringify({ version: 1, integrations: [entry] })
    )
    const result = await serve(directory, ["doctor", "borrowed"])
    expect(result.code, result.output).toBe(1)
    expect(result.output).toContain("unauthorized stored credential")
    expect(upstream.requests).toEqual([])
    expect(result.output).not.toContain("unrelated-fixture-secret")
    expect(() => readIntegrations(directory, undefined, {})).toThrow("unauthorized stored credential")
    await expect(probe(entry, "unrelated-fixture-secret")).rejects.toThrow("unauthorized stored credential")
    expect(upstream.requests).toEqual([])
  })

  it("resolves encrypted credential references through the real local store", async () => {
    const directory = await root()
    const upstream = await github()
    vi.stubEnv("SMITHERS_GITHUB_API_BASE_URL", upstream.origin)
    vi.stubEnv("SMITHERS_GITHUB_CREDENTIAL_IDS", " other-token, stored-token ")
    vi.stubEnv("SMITHERS_CREDENTIAL_KEY", Buffer.alloc(32, 9).toString("base64"))
    await withCredentials({ root: directory }, (service) =>
      service.create({
        id: "stored-token",
        name: "GitHub fixture",
        secret: Redacted.make("encrypted-fixture-secret")
      }), true)
    await Fs.writeFile(
      Path.join(directory, ".smithers/integrations.json"),
      JSON.stringify({
        version: 1,
        integrations: [{ id: "gh", provider: "github", credentialId: "stored-token", apiBaseUrl: upstream.origin }]
      })
    )
    const result = await serve(directory, ["doctor", "gh", "--offline"])
    expect(result.code, result.output).toBe(0)
    expect(result.data.integrations).toEqual([
      { id: "gh", provider: "github", healthy: true, check: "credential-present" }
    ])
    expect(result.output).not.toContain("encrypted-fixture-secret")
    expect(upstream.requests).toEqual([])
    const online = await serve(directory, ["doctor", "gh"])
    expect(online.code, online.output).toBe(0)
    expect(upstream.requests).toEqual([{ path: "/rate_limit", authorization: "Bearer encrypted-fixture-secret" }])
    expect(online.output).not.toContain("encrypted-fixture-secret")
  })

  it("reports online health without returning provider response bodies or request details", async () => {
    const directory = await root()
    const upstream = await github({ status: 200, body: { private: "response-fixture-secret" } })
    vi.stubEnv("SMITHERS_GITHUB_TOKEN", "request-fixture-secret")
    vi.stubEnv("SMITHERS_GITHUB_API_BASE_URL", upstream.origin)
    await Fs.writeFile(
      Path.join(directory, ".smithers/integrations.json"),
      JSON.stringify({
        version: 1,
        integrations: [{ id: "gh", provider: "github", apiBaseUrl: upstream.origin }]
      })
    )
    const healthy = await serve(directory, ["doctor", "gh"])
    expect(healthy.code, healthy.output).toBe(0)
    expect(healthy.data.integrations).toEqual([
      { id: "gh", provider: "github", healthy: true, check: "provider-authentication" }
    ])
    upstream.state.answer = { status: 401, body: { message: "response-fixture-secret" } }
    const unhealthy = await serve(directory, ["doctor", "gh"])
    expect(unhealthy.code).toBe(1)
    expect(unhealthy.output).toContain("Credential lookup or provider authentication failed")
    for (const result of [healthy, unhealthy]) {
      expect(result.output).not.toContain("request-fixture-secret")
      expect(result.output).not.toContain("response-fixture-secret")
    }
  })

  it("refuses an unknown integration before requests", async () => {
    const directory = await root()
    const upstream = await github()
    vi.stubEnv("SMITHERS_GITHUB_API_BASE_URL", upstream.origin)
    const config = Path.join(directory, ".smithers/integrations.json")
    await Fs.writeFile(
      config,
      JSON.stringify({ version: 1, integrations: [{ id: "github", provider: "github", apiBaseUrl: upstream.origin }] })
    )
    expect((await serve(directory, ["doctor", "unknown"])).output).toContain("Unknown integration")
    expect(upstream.requests).toEqual([])
  })

  it("prints a diagnostic receipt for a non-Error failure at the operator boundary", async () => {
    let rendered: unknown
    const result = await Presentation.guard({
      error: (error) => {
        rendered = error
        return undefined as never
      }
    }, async () => {
      throw "Authorization: Bearer operator-fixture-secret"
    }, { code: "operator_failed" })
    expect(result).toBeUndefined()
    expect(rendered).toEqual({
      code: "operator_failed",
      exitCode: 1,
      message: expect.stringContaining("Diagnostics: ")
    })
  })

  it("lists only credential references and refuses raw secret fields", async () => {
    const directory = await root()
    vi.stubEnv("SMITHERS_INTEGRATION_TOKEN_ENV", "TEST_MISSING_TOKEN")
    const config = Path.join(directory, ".smithers/integrations.json")
    await Fs.writeFile(
      config,
      JSON.stringify({
        version: 1,
        integrations: [{ id: "github", provider: "github", tokenEnv: "TEST_MISSING_TOKEN" }]
      })
    )
    expect((await serve(directory, ["list"])).data).toEqual([{
      id: "github",
      provider: "github",
      tokenEnv: "TEST_MISSING_TOKEN"
    }])
    expect((await serve(directory, ["doctor", "--offline"])).code).toBe(1)
    await Fs.writeFile(
      config,
      JSON.stringify({ version: 1, integrations: [{ id: "github", provider: "github", token: "secret-value" }] })
    )
    const result = await serve(directory, ["list"])
    expect(result.code).toBe(1)
    expect(result.output).not.toContain("secret-value")
  })

  it("discovers GitHub and verifies it through the existing client", async () => {
    const directory = await root()
    expect(readIntegrations(directory, undefined, { SMITHERS_LINEAR_API_KEY: "secret" })).toEqual([])
    const upstream = await github()
    vi.stubEnv("SMITHERS_GITHUB_API_BASE_URL", upstream.origin)
    for (const provider of ["github"] as const) {
      expect(await probe({ id: provider, provider, apiBaseUrl: upstream.origin }, "test-token"))
        .toMatchObject({ healthy: true })
    }
    expect(upstream.requests).toEqual([{ path: "/rate_limit", authorization: "Bearer test-token" }])
  })

  it.each(["GITHUB_TOKEN", "SMITHERS_GITHUB_TOKEN", "TEAM_GITHUB_TOKEN"])(
    "uses the host Enterprise endpoint with %s when no entry endpoint is declared",
    async (tokenEnv) => {
      const directory = await root()
      const enterprise = await github()
      vi.stubEnv("GITHUB_TOKEN", "fallback-fixture-secret")
      vi.stubEnv("SMITHERS_GITHUB_TOKEN", tokenEnv === "SMITHERS_GITHUB_TOKEN" ? "enterprise-fixture-secret" : "")
      vi.stubEnv(tokenEnv, "enterprise-fixture-secret")
      vi.stubEnv("SMITHERS_GITHUB_API_BASE_URL", `${enterprise.origin}/api/v3`)
      if (tokenEnv === "TEAM_GITHUB_TOKEN") {
        vi.stubEnv("SMITHERS_INTEGRATION_TOKEN_ENV", tokenEnv)
        await Fs.writeFile(
          Path.join(directory, ".smithers/integrations.json"),
          JSON.stringify({ version: 1, integrations: [{ id: "github", provider: "github", tokenEnv }] })
        )
      }
      const result = await serve(directory, ["doctor", "--timeout-ms", "1000"])
      expect(result.code, result.output).toBe(0)
      expect(result.data).toEqual({
        healthy: true,
        integrations: [{ id: "github", provider: "github", healthy: true, check: "provider-authentication" }]
      })
      expect(enterprise.requests).toEqual([{
        path: "/api/v3/rate_limit",
        authorization: "Bearer enterprise-fixture-secret"
      }])
      expect(result.output).not.toContain("enterprise-fixture-secret")
      expect(result.output).not.toContain("fallback-fixture-secret")
    }
  )

  it("keeps the explicit endpoint and probe token ahead of host defaults", async () => {
    const upstream = await github()
    vi.stubEnv("SMITHERS_GITHUB_TOKEN", "ambient-fixture-secret")
    vi.stubEnv("SMITHERS_GITHUB_API_BASE_URL", `${upstream.origin}/host/api/v3`)
    expect(
      await probe(
        { id: "explicit", provider: "github", apiBaseUrl: `${upstream.origin}/entry/api/v3` },
        "explicit-fixture-secret"
      )
    )
      .toEqual({ id: "explicit", provider: "github", healthy: true })
    expect(upstream.requests).toEqual([{
      path: "/entry/api/v3/rate_limit",
      authorization: "Bearer explicit-fixture-secret"
    }])
  })

  it.each([
    "not-a-url",
    "ftp://example.invalid",
    "http://example.invalid",
    "https://user:private-fixture@example.invalid",
    "https://example.invalid?token=private-fixture",
    "https://example.invalid#private-fixture"
  ])("validates the inherited endpoint before sending a probe: %s", async (apiBaseUrl) => {
    vi.stubEnv("SMITHERS_GITHUB_API_BASE_URL", apiBaseUrl)
    await expect(probe({ id: "github", provider: "github" }, "probe-fixture-secret", 200)).rejects.toMatchObject({
      fault: "user",
      code: "operator_failed",
      message: "Integration github resolves an invalid github API endpoint"
    })
  })

  it("authorizes no extra origin when the host endpoint variable is malformed", async () => {
    const directory = await root()
    const upstream = await github()
    await Fs.writeFile(
      Path.join(directory, ".smithers/integrations.json"),
      JSON.stringify({
        version: 1,
        integrations: [{ id: "github", provider: "github", apiBaseUrl: upstream.origin }]
      })
    )
    expect(() => readIntegrations(directory, undefined, { SMITHERS_GITHUB_API_BASE_URL: "not-a-url" }))
      .toThrow(`unauthorized github endpoint ${upstream.origin}`)
    expect(upstream.requests).toEqual([])
  })

  it("validates a hand-built entry endpoint even when its origin is authorized", async () => {
    const upstream = await github()
    vi.stubEnv("SMITHERS_GITHUB_API_BASE_URL", upstream.origin)
    await expect(
      probe(
        { id: "github", provider: "github", apiBaseUrl: `${upstream.origin}?token=private-fixture` },
        "probe-fixture-secret"
      )
    )
      .rejects.toMatchObject({ fault: "user", message: "Integration github resolves an invalid github API endpoint" })
    expect(upstream.requests).toEqual([])
  })

  it("refuses credentials and destinations the host never authorized, and accepts the ones it did", async () => {
    const directory = await root()
    const config = Path.join(directory, ".smithers/integrations.json")
    const declare = (integration: Record<string, unknown>) =>
      Fs.writeFile(config, JSON.stringify({ version: 1, integrations: [integration] }))
    const attacker = await github()
    const enterprise = await github()
    vi.stubEnv("SMITHERS_CREDENTIAL_KEY", "host-encryption-fixture-secret")

    await declare({
      id: "exfil",
      provider: "github",
      tokenEnv: "SMITHERS_CREDENTIAL_KEY",
      apiBaseUrl: attacker.origin
    })
    const borrowed = await serve(directory, ["doctor", "exfil"])
    expect(borrowed.code).toBe(1)
    expect(borrowed.output).toContain("unauthorized credential variable SMITHERS_CREDENTIAL_KEY")
    expect(borrowed.output).not.toContain("host-encryption-fixture-secret")
    expect(attacker.requests).toEqual([])

    await declare({ id: "exfil", provider: "github", apiBaseUrl: attacker.origin })
    const redirected = await serve(directory, ["doctor", "exfil"])
    expect(redirected.code).toBe(1)
    expect(redirected.output).toContain(`unauthorized github endpoint ${attacker.origin}`)
    expect(attacker.requests).toEqual([])
    await expect(
      probe({ id: "exfil", provider: "github", apiBaseUrl: attacker.origin }, "probe-fixture-secret")
    ).rejects.toThrow("unauthorized github endpoint")
    expect(attacker.requests).toEqual([])

    vi.stubEnv("SMITHERS_INTEGRATION_TOKEN_ENV", "TEAM_GITHUB_TOKEN")
    vi.stubEnv("SMITHERS_GITHUB_API_BASE_URL", `${enterprise.origin}/api/v3`)
    vi.stubEnv("TEAM_GITHUB_TOKEN", "authorized-fixture-secret")
    await declare({
      id: "enterprise",
      provider: "github",
      tokenEnv: "TEAM_GITHUB_TOKEN",
      apiBaseUrl: `${enterprise.origin}/api/v3`
    })
    const authorized = await serve(directory, ["doctor", "enterprise"])
    expect(authorized.code, authorized.output).toBe(0)
    expect(authorized.data.integrations).toEqual([
      { id: "enterprise", provider: "github", healthy: true, check: "provider-authentication" }
    ])
    expect(enterprise.requests).toEqual([{
      path: "/api/v3/rate_limit",
      authorization: "Bearer authorized-fixture-secret"
    }])
    expect(attacker.requests).toEqual([])
    expect(authorized.output).not.toContain("authorized-fixture-secret")
  })
})

for (const provider of ["linear", "telegram", "slack", "gmail", "googlecalendar", "x"]) {
  it(`refuses stored ${provider} configuration without sending a diagnostic request`, async () => {
    const directory = await root()
    await Fs.writeFile(
      Path.join(directory, ".smithers/integrations.json"),
      JSON.stringify({ version: 1, integrations: [{ id: "retired", provider }] })
    )
    const result = await serve(directory, ["doctor"])
    expect(result.code).toBe(1)
    expect(result.output).toContain("integrations.0.provider is invalid")
  })
}
