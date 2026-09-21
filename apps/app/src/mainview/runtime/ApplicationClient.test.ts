import { resolveApplicationTarget } from "@smthrs/rpc/ApplicationTarget"
import { describe, expect, test } from "bun:test"
import { ApplicationClientError, createApplicationClient } from "./ApplicationClient"

const pageOrigin = "https://app.example.test"
const target = (mode: "web-selfhost" | "web-plue" | "local-own" | "local-plue" | "native-own" | "native-plue") => {
  const plue = mode.endsWith("plue")
  const apiOrigin = mode.startsWith("web-") ? "" : plue ? "https://plue.example.test" : "http://127.0.0.1:4100"
  return resolveApplicationTarget({
    apiVersion: 1,
    mode,
    apiOrigin,
    auth: {
      kind: plue && apiOrigin !== "" ? "bearer" : mode.includes("own") && !mode.startsWith("web-") ? "token" : "session"
    },
    cors: plue && apiOrigin !== "" ? "credentialed" : "same-origin",
    developerExternal: mode === "web-plue" && apiOrigin !== ""
  }, pageOrigin)
}

describe("application client", () => {
  test("the six targets share URL and auth behavior", async () => {
    for (const mode of ["web-selfhost", "web-plue", "local-own", "local-plue", "native-own", "native-plue"] as const) {
      const seen: Array<{ url: string; auth: string | null; credentials: RequestCredentials | undefined }> = []
      const client = createApplicationClient(target(mode), {
        token: () => "secret",
        fetchImpl: async (input, init) => {
          seen.push({
            url: String(input),
            auth: new Headers(init?.headers).get("authorization"),
            credentials: init?.credentials
          })
          return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } })
        }
      })
      await expect(client.request("/api/bootstrap")).resolves.toEqual({ ok: true })
      const call = seen[0]!
      expect(call.url).toBe(client.baseUrl === "" ? "/api/bootstrap" : `${client.baseUrl}/api/bootstrap`)
      if (client.target.auth.kind === "session") {
        expect(call).toMatchObject({ auth: null, credentials: "include" })
      } else {
        expect(call).toMatchObject({
          auth: `${client.target.auth.kind === "bearer" ? "Bearer" : "token"} secret`,
          credentials: "omit"
        })
      }
    }
  })

  test("cancellation, auth, API refusals, and invalid responses stay distinct", async () => {
    const session = target("web-selfhost")
    const cancelled = createApplicationClient(session, {
      fetchImpl: async (_input, init) => {
        await new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
        )
        return new Response()
      }
    })
    const abort = new AbortController()
    const pending = cancelled.request("/api/wait", { signal: abort.signal })
    abort.abort()
    await expect(pending).rejects.toMatchObject({ code: "cancelled" })

    await expect(createApplicationClient(target("native-plue")).request("/api/user"))
      .rejects.toMatchObject({ code: "auth-missing" })

    const refused = createApplicationClient(session, {
      fetchImpl: async () =>
        new Response(JSON.stringify({ code: "access_denied", message: "Denied." }), {
          status: 403,
          headers: { "retry-after": "4" }
        })
    })
    await expect(refused.request("/api/user")).rejects.toMatchObject({
      code: "forbidden",
      apiCode: "access_denied",
      status: 403,
      retryAfterSeconds: 4
    })

    const invalid = createApplicationClient(session, { fetchImpl: async () => new Response("not json") })
    await expect(invalid.request("/api/user")).rejects.toBeInstanceOf(ApplicationClientError)
    await expect(invalid.request("/api/user")).rejects.toMatchObject({ code: "invalid-response" })
  })

  test("never attaches an application credential to another origin", async () => {
    let calls = 0
    const client = createApplicationClient(target("native-plue"), {
      token: () => "secret",
      fetchImpl: async () => {
        calls += 1
        return new Response()
      }
    })
    await expect(client.stream("https://elsewhere.example.test/api/user"))
      .rejects.toMatchObject({ code: "invalid-target" })
    expect(calls).toBe(0)
  })

  test("explicit web Plue development uses the selected origin and bearer auth", async () => {
    const selected = resolveApplicationTarget({
      apiVersion: 1,
      mode: "web-plue",
      apiOrigin: "https://plue.example.test",
      auth: { kind: "bearer" },
      cors: "credentialed",
      developerExternal: true
    }, pageOrigin)
    let call: { readonly url: string; readonly authorization: string | null } | undefined
    const client = createApplicationClient(selected, {
      token: () => "developer-token",
      fetchImpl: async (input, init) => {
        call = { url: String(input), authorization: new Headers(init?.headers).get("authorization") }
        return Response.json({ ok: true })
      }
    })
    await client.request("/api/bootstrap")
    expect(call).toEqual({
      url: "https://plue.example.test/api/bootstrap",
      authorization: "Bearer developer-token"
    })
  })
})
