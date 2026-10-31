import { it } from "@effect/vitest"
import { Effect } from "effect"
import { createHmac } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect } from "vitest"
import { WebSocketServer } from "ws"
import { Client } from "../src/internal/backend/Client.ts"
import * as ProductApi from "../src/internal/backend/ProductApi.ts"
import { withTemporaryDirectory } from "./helpers/TemporaryDirectory.ts"
import { spawnNodeSync } from "./support/node-child.ts"

const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise(run)

/** Real HTTP transport and WebSocket peer; no replaced network or credential service. */
const fixture = Effect.acquireRelease(
  attempt(async () => {
    const rows = [{ id: "confirmation-1", state: "pending", command: "issue.comment" }]
    const server = createServer(async (request, response) => {
      const chunks: Array<Buffer> = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify(
        request.url === "/api/confirmations" ? rows : {
          method: request.method,
          path: request.url,
          body: Buffer.concat(chunks).toString("utf8"),
          headers: request.headers
        }
      ))
    })
    const sockets = new WebSocketServer({ server, path: "/api/live" })
    sockets.on("connection", (socket) => {
      socket.on("message", (data) => {
        const input = JSON.parse(data.toString())
        socket.send(JSON.stringify({ t: "snap", id: input.id, cursor: 1, data: { topic: input.topic } }))
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("Missing loopback port")
    const origin = `http://127.0.0.1:${address.port}`
    const client = new Client({ environment: { SMITHERS_API_ORIGIN: origin, SMITHERS_TOKEN: "loopback-test" } })
    const transport = Object.assign(client, {
      connect: async (path: string, protocols: Array<string>) => {
        const socket = new WebSocket(origin.replace(/^http/, "ws") + path, protocols)
        await new Promise<void>((resolve, reject) => {
          socket.addEventListener("open", () => resolve(), { once: true })
          socket.addEventListener("error", reject, { once: true })
        })
        return socket
      }
    })
    return { transport, server, sockets, rows }
  }),
  ({ server, sockets }) =>
    attempt(async () => {
      for (const socket of sockets.clients) socket.terminate()
      await new Promise<void>((resolve, reject) => sockets.close((error) => error ? reject(error) : resolve()))
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }).pipe(Effect.orDie)
)

it.effect("confirmation list preserves the returned rows, including an empty list", () =>
  Effect.scoped(Effect.gen(function*() {
    const { transport, rows } = yield* fixture
    expect(yield* attempt(() => ProductApi.getApiConfirmations(transport))).toEqual(rows)
    rows.splice(0)
    expect(yield* attempt(() => ProductApi.getApiConfirmations(transport))).toEqual([])
  })))

it.effect("GitHub webhook transmits exact signed payload bytes and per-delivery headers", () =>
  Effect.scoped(Effect.gen(function*() {
    const { transport } = yield* fixture
    for (const delivery of ["delivery-1", "delivery-2"]) {
      const body = `{ "delivery": "${delivery}", "label": "é" }\n`
      const headers = {
        "X-GitHub-Event": "push",
        "X-GitHub-Delivery": delivery,
        "X-Hub-Signature-256": `sha256=${createHmac("sha256", "webhook-test").update(body).digest("hex")}`
      }
      const result = yield* attempt(() => ProductApi.postWebhooksGithub(transport, { body, headers }))
      expect(result).toMatchObject({
        method: "POST",
        path: "/webhooks/github",
        body,
        headers: {
          "content-type": "application/json",
          "x-github-event": "push",
          "x-github-delivery": delivery,
          "x-hub-signature-256": headers["X-Hub-Signature-256"]
        }
      })
    }
  })))

it.effect("owner settings reject invalid request bodies at compile time", () =>
  Effect.promise(() =>
    withTemporaryDirectory("smithers-product-types-", async (root) => {
      const file = fileURLToPath(new URL("./fixtures/product-api-install.types.ts", import.meta.url))
      // Keep the full real compiler check outside V8's instrumented test worker.
      // It still checks every transitive implementation and all @ts-expect-error cases.
      const compiler = join(dirname(createRequire(import.meta.url).resolve("vibelang/package.json")), "bin/vibelang")
      const config = join(root, "tsconfig.json")
      await writeFile(
        config,
        JSON.stringify({
          compilerOptions: {
            target: "ES2024",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            allowImportingTsExtensions: true,
            typeRoots: [join(import.meta.dirname, "../node_modules/@types")]
          },
          files: [file]
        })
      )
      const result = spawnNodeSync([compiler, "-p", config], { encoding: "utf8", timeout: 25_000 })
      expect(result.error).toBeUndefined()
      expect(result.status, result.stdout + result.stderr).toBe(0)
    })
  ))

it.effect("live subscription returns a usable WebSocket and its projection events", () =>
  Effect.scoped(Effect.gen(function*() {
    const { transport } = yield* fixture
    const socket = yield* attempt(() => ProductApi.getApiLive(transport))
    expect(socket).toBeInstanceOf(WebSocket)
    expect(socket.protocol).toBe("smithers.live.v1")
    const message = new Promise<MessageEvent>((resolve) => socket.addEventListener("message", resolve, { once: true }))
    socket.send(JSON.stringify({ t: "sub", id: 7, topic: "home" } satisfies ProductApi.LiveSubscription))
    expect(JSON.parse((yield* attempt(() => message)).data)).toEqual({
      t: "snap",
      id: 7,
      cursor: 1,
      data: { topic: "home" }
    })
    socket.close()
  })))

it.effect("OAuth token exchange transmits authorization code and refresh parameters", () =>
  Effect.scoped(Effect.gen(function*() {
    const { transport } = yield* fixture
    for (
      const body of [
        {
          grant_type: "authorization_code",
          client_id: "app",
          client_secret: "secret",
          code: "code",
          redirect_uri: "https://example.com/callback",
          code_verifier: "verifier"
        },
        { grant_type: "refresh_token", client_id: "app", refresh_token: "refresh" }
      ] as const
    ) {
      expect(yield* attempt(() => ProductApi.postApiOauth2Token(transport, { body }))).toMatchObject({
        method: "POST",
        path: "/api/oauth2/token",
        body: JSON.stringify(body)
      })
    }
  })))

it.effect("notification preferences transmit false and omitted partial settings", () =>
  Effect.scoped(Effect.gen(function*() {
    const { transport } = yield* fixture
    const settings: Array<ProductApi.PutApiNotificationsPreferencesBody> = [
      { notify_issues: false, notify_landings: true },
      { notify_mentions: false },
      { notify_issues: null },
      {}
    ]
    for (const body of settings) {
      expect(yield* attempt(() => ProductApi.putApiNotificationsPreferences(transport, { body }))).toMatchObject({
        method: "PUT",
        path: "/api/notifications/preferences",
        body: JSON.stringify(body)
      })
    }
  })))
