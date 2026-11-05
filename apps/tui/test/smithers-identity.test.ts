/** #4385: connection and the person it authenticates are projected together, without credentials. */
import * as CloudSession from "@smthrs/cli/CloudSession"
import { expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Panels from "../src/panels.ts"
import * as Smithers from "../src/smithers.ts"

const connection = (
  status?: { logged_in: boolean; verified?: boolean; username?: string | null; email?: string | null }
) => {
  const panel = Smithers.panel([], new Set(), undefined, status)
  expect(Panels.decode(panel)).toEqual(panel)
  return panel.rows.find((row) => row.id === "cloud:identity")
}

it("shows the authenticated username beside the connection", () => {
  expect(connection({ logged_in: true, username: "will", email: "will@example.test" }))
    .toEqual({ id: "cloud:identity", label: "Connected · @will", details: [] })
})

it("uses email when the authenticated person has no username", () => {
  expect(connection({ logged_in: true, email: "will@example.test" })?.label)
    .toBe("Connected · will@example.test")
  expect(connection({ logged_in: true, username: null, email: null })?.label).toBe("Connected · identity unknown")
  expect(connection({ logged_in: true })?.label).toBe("Connected · identity unknown")
})

it("distinguishes unknown and offline from signed out, discarding unverified cached identities", () => {
  expect(connection()?.label).toBe("Connection unknown")
  expect(connection({ logged_in: true, verified: false, username: "old-person" })?.label)
    .toBe("Offline · identity unverified")
  expect(connection({ logged_in: false, username: "old-person" })?.label).toBe("Signed out")
})

it("never renders extra credential fields from auth status", () => {
  const status = { logged_in: true, username: "will", token: "tok_identity_sentinel", access_token: "secret_sentinel" }
  const panel = Smithers.panel([], new Set(), undefined, status)
  expect(JSON.stringify(panel)).not.toContain(status.token)
  expect(JSON.stringify(panel)).not.toContain(status.access_token)
  expect(panel.rows[0]?.label).toBe("Connected · @will")
})

it("keeps terminal controls and long identity fields within the panel schema", () => {
  expect(connection({ logged_in: true, username: " \u001b[31mwill\n\u009b\r " })?.label)
    .toBe("Connected · @[31mwill")
  expect(connection({ logged_in: true, username: " ", email: " will@example.test " })?.label)
    .toBe("Connected · will@example.test")
  expect(connection({ logged_in: true, username: "a".repeat(1000) })?.label)
    .toBe(`Connected · @${"a".repeat(160)}`)
})

it("projects a faulty Effect authentication service as unknown without exposing its diagnostic", async () => {
  const faulty = Layer.succeed(CloudSession.Authentication)({
    status: Effect.fail(new Error("keyring unavailable tok_diagnostic_sentinel"))
  })
  const status = await Effect.runPromise(Smithers.readIdentity.pipe(Effect.provide(faulty)))
  expect(status).toBeUndefined()
  expect(connection(status)?.label).toBe("Connection unknown")
  expect(JSON.stringify(connection(status))).not.toContain("tok_diagnostic_sentinel")
})

it("does not claim a person while the injected authentication read is unfinished", async () => {
  let finish!: (status: CloudSession.AuthStatus) => void
  const pending = new Promise<CloudSession.AuthStatus>((resolve) => {
    finish = resolve
  })
  const service = Layer.succeed(CloudSession.Authentication)({ status: Effect.promise(() => pending) })
  const result = Effect.runPromise(Smithers.readIdentity.pipe(Effect.provide(service)))
  expect(connection()?.label).toBe("Connection unknown")
  finish({ logged_in: true, username: "new-person" })
  expect(connection(await result)?.label).toBe("Connected · @new-person")
})

it("uses the real CLI auth status transport and excludes credential metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "identity-auth-"))
  const seen: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      seen.push(new URL(request.url).pathname)
      expect(request.headers.get("authorization")).toBe("token tok_identity_transport_sentinel")
      return Response.json({ login: "transport-person", email: "person@example.test", token: "tok_response_sentinel" })
    }
  })
  try {
    const status = await Effect.runPromise(Smithers.readIdentity.pipe(
      Effect.provide(CloudSession.layerAuthentication({
        HOME: root,
        XDG_CONFIG_HOME: root,
        SMITHERS_API_ORIGIN: `http://127.0.0.1:${server.port}`,
        SMITHERS_TOKEN: "tok_identity_transport_sentinel"
      }))
    ))
    expect(seen).toEqual(["/api/user"])
    expect(status).toEqual({ logged_in: true, username: "transport-person", email: "person@example.test" })
    expect(connection(status)?.label).toBe("Connected · @transport-person")
    expect(JSON.stringify(status)).not.toContain("tok_")
  } finally {
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

it("retains explicit offline and signed-out states from injected Effect services", async () => {
  for (
    const [status, expected] of [
      [{ logged_in: true, verified: false, username: "cached-person" }, "Offline · identity unverified"],
      [{ logged_in: false, username: "cached-person" }, "Signed out"],
      [{ logged_in: true, verified: true, username: "verified-person" }, "Connected · @verified-person"]
    ] as const
  ) {
    const service = Layer.succeed(CloudSession.Authentication)({ status: Effect.succeed(status) })
    const result = await Effect.runPromise(Smithers.readIdentity.pipe(Effect.provide(service)))
    expect(connection(result)?.label).toBe(expected)
  }
})

it("cancels an unfinished authentication Effect without producing a status update", async () => {
  const controller = new AbortController()
  const service = Layer.succeed(CloudSession.Authentication)({ status: Effect.never })
  const result = Effect.runPromise(Smithers.readIdentity.pipe(Effect.provide(service)), { signal: controller.signal })
  controller.abort()
  await expect(result).rejects.toBeDefined()
})

it("keeps invalid configuration unknown through the real authentication layer", async () => {
  const root = mkdtempSync(join(tmpdir(), "identity-invalid-"))
  try {
    const result = await Effect.runPromise(Smithers.readIdentity.pipe(
      Effect.provide(CloudSession.layerAuthentication({
        HOME: root,
        XDG_CONFIG_HOME: root,
        SMITHERS_API_ORIGIN: "https://person:tok_config_sentinel@example.test"
      }))
    ))
    expect(result).toBeUndefined()
    expect(connection(result)?.label).toBe("Connection unknown")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it("does not turn factory unavailability into a sign-in claim while authentication is uncertain or still valid", () => {
  for (const status of [undefined, { logged_in: true, verified: false }, { logged_in: true, username: "will" }]) {
    const panel = Smithers.panel([], new Set(), "signed-out", status)
    expect(Panels.decode(panel)).toEqual(panel)
    expect(panel.rows).toHaveLength(1)
    expect(panel.rows.some((row) => row.id === "factory:sign-in")).toBe(false)
  }
})
