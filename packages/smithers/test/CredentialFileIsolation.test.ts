import { Evaluator, ModelRequest, RequestExecutor } from "@smthrs/model"
import { Effect, Layer, Logger, References, Stream } from "effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Session } from "../src/internal/backend/Session.ts"
import { layerSeatEvaluator } from "../src/internal/NativeEquipment.ts"
import * as NodeControl from "../src/NodeControl.ts"
import * as Providers from "../src/Providers.ts"

const root = mkdtempSync(join(tmpdir(), "smithers-credential-isolation-"))
const originalHome = process.env.HOME
const environment: Record<string, string | undefined> = {
  PATH: process.env.PATH,
  LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
  HOME: root,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_RUNTIME_DIR: root,
  SMITHERS_API_ORIGIN: "https://api.credential-isolation.test"
}
const origin = environment.SMITHERS_API_ORIGIN!
let busPid: number | undefined
let keyringPid: number | undefined
beforeAll(() => {
  process.env.HOME = root
  if (process.platform === "linux") {
    const [address, pid] = execFileSync("dbus-daemon", ["--session", "--fork", "--print-address=1", "--print-pid=1"], {
      encoding: "utf8",
      env: environment
    }).trim().split("\n")
    busPid = Number(pid)
    environment.DBUS_SESSION_BUS_ADDRESS = address
    const output = execFileSync("gnome-keyring-daemon", ["--unlock", "--components=secrets"], {
      input: "fixture-password",
      encoding: "utf8",
      env: environment
    })
    for (const line of output.trim().split("\n")) {
      const split = line.indexOf("=")
      if (split > 0) environment[line.slice(0, split)] = line.slice(split + 1)
    }
    if (environment.GNOME_KEYRING_PID) keyringPid = Number(environment.GNOME_KEYRING_PID)
  }
})
afterAll(() => {
  if (keyringPid) process.kill(keyringPid, "SIGTERM")
  if (busPid) process.kill(busPid, "SIGTERM")
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  rmSync(root, { recursive: true, force: true })
})
const session = (file: string, extra: Record<string, string> = {}) =>
  new Session({
    ...environment,
    SMITHERS_AUTH_FILE: join(root, file),
    ...extra
  })

describe("credential-store isolation (#4223)", () => {
  it("keeps simultaneous logins to one origin independent through reload and logout", async () => {
    const a = new Session(environment), b = session("bob.json")
    await Promise.all([a.save(origin, "synthetic-alice-token"), b.save(origin, "synthetic-bob-token")])
    expect((await new Session(environment).require()).token === "synthetic-alice-token").toBe(true)
    expect((await session("bob.json").require()).token === "synthetic-bob-token").toBe(true)
    expect(readFileSync(a.authPath, "utf8")).not.toContain("synthetic-alice-token")
    expect(readFileSync(b.authPath, "utf8")).not.toContain("synthetic-bob-token")
    await a.clear()
    expect(await a.resolve()).toBeUndefined()
    expect((await b.require()).token === "synthetic-bob-token").toBe(true)
    await b.clear()
  })

  it("uses one canonical identity for relative paths and symlinked parents", async () => {
    const directory = join(root, "canonical")
    mkdirSync(directory)
    symlinkSync(directory, join(root, "alias"), "dir")
    const a = session("canonical/auth.json")
    const b = session("unused", { SMITHERS_AUTH_FILE: relative(process.cwd(), join(root, "alias/auth.json")) })
    await a.save(origin, "synthetic-canonical-token")
    expect((await b.require()).token === "synthetic-canonical-token").toBe(true)
    await b.clear()
    expect(await a.resolve()).toBeUndefined()
  })

  it("separates the full API origin even when hostnames match", async () => {
    const a = session("ports.json")
    await a.keyring("set", "https://api.credential-isolation.test:8443", "synthetic-first-port")
    await a.keyring("set", "https://api.credential-isolation.test:9443", "synthetic-second-port")
    expect(await a.keyring("get", "https://api.credential-isolation.test:8443") === "synthetic-first-port").toBe(true)
    expect(await a.keyring("get", "https://api.credential-isolation.test:9443") === "synthetic-second-port").toBe(true)
    await a.keyring("delete", "https://api.credential-isolation.test:8443")
    await a.keyring("delete", "https://api.credential-isolation.test:9443")
  })
})

const legacy = (action: "set" | "get" | "delete", host: string, token?: string): string => {
  if (process.platform === "linux") {
    const args = [
      action === "set" ? "store" : action === "get" ? "lookup" : "clear",
      ...(action === "set" ? ["--label=Smithers CLI isolation test"] : []),
      "service",
      "smithers-cli",
      "host",
      host
    ]
    try {
      return execFileSync("secret-tool", args, { input: token, env: environment, encoding: "utf8" }).trim()
    } catch (error) {
      if (action !== "set" && (error as { status?: number }).status === 1) return ""
      throw error
    }
  }
  const args = [
    action === "set" ? "add-generic-password" : action === "get" ? "find-generic-password" : "delete-generic-password",
    "-s",
    "smithers-cli",
    "-a",
    host,
    ...(action === "get" ? ["-w"] : [])
  ]
  if (action === "set") {
    // Synthetic test data alone. The production writer uses stdin.
    args.push("-U", "-w", token!)
  }
  try {
    return execFileSync("security", args, { env: environment, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })
      .trim()
  } catch (error) {
    if (action !== "set" && (error as { status?: number }).status === 44) return ""
    throw error
  }
}

describe("legacy credential migration (#4223)", () => {
  it("an alternate process HOME cannot claim or delete a legacy credential", async () => {
    const host = "credential-isolation.test"
    legacy("set", host, "synthetic-legacy-token")
    // beforeAll sets the real process HOME too, as a CLI launched with HOME=...
    // does. os.homedir() alone would incorrectly trust this store.
    const alternate = new Session(environment)
    alternate.write(alternate.authPath, JSON.stringify({ api_url: origin, host }))
    expect(await alternate.resolve()).toBeUndefined()
    const custom = session("legacy-custom.json")
    custom.write(custom.authPath, JSON.stringify({ api_url: origin, host }))
    expect(await custom.resolve()).toBeUndefined()
    await alternate.clear()
    await custom.clear()
    expect(legacy("get", host) === "synthetic-legacy-token").toBe(true)
    await alternate.save(origin, "synthetic-new-token")
    expect((await alternate.require()).token === "synthetic-new-token").toBe(true)
    expect(JSON.parse(readFileSync(alternate.authPath, "utf8")).credential_store).toBe("v2")
    await alternate.clear()
    expect(await alternate.resolve()).toBeUndefined()
    expect(legacy("get", host) === "synthetic-legacy-token").toBe(true)
    legacy("delete", host)
  })

  it("keeps a file-backed login authoritative over an older native credential", async () => {
    const current = session("file-priority.json")
    await current.save(origin, "synthetic-old-native-token")
    current.write(current.authPath, JSON.stringify({ api_url: origin, token: "synthetic-file-token" }))
    expect((await current.require()).token === "synthetic-file-token").toBe(true)
    await current.clear()
  })

  it("does not share lookup identities between empty stores", () => {
    const a = session("empty-a.json"), b = session("empty-b.json")
    expect(a.credentialIdentity(origin)).not.toBe(b.credentialIdentity(origin))
  })
})

describe("provider key files (#4300)", () => {
  const keyFile = (name: string, contents = "synthetic-provider-key\n", mode = 0o600) => {
    const path = join(root, name)
    writeFileSync(path, contents, { mode })
    chmodSync(path, mode)
    return path
  }

  it.each([
    ["vercel", "AI_GATEWAY_API_KEY"],
    ["moonshot", "MOONSHOT_API_KEY"],
    ["gemini", "GEMINI_API_KEY"],
    ["gemini", "GOOGLE_API_KEY"],
    ["cerebras", "CEREBRAS_API_KEY"]
  ])("resolves %s from a private %s_FILE without exporting its value", (provider, variable) => {
    const path = keyFile(`${variable}.key`)
    const env = Object.freeze({ [`${variable}_FILE`]: path })
    const found = Providers.compatibleKey(provider!, env)
    expect(found?.key === "synthetic-provider-key").toBe(true)
    expect(found?.variable).toBe(`${variable}_FILE`)
    const child = execFileSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], {
      encoding: "utf8",
      env
    })
    expect(child.includes("synthetic-provider-key")).toBe(false)
    expect(JSON.parse(child)[variable!]).toBeUndefined()
    expect(Object.keys(env)).toEqual([`${variable}_FILE`])
  })

  it("gives every direct variable priority over files, then uses declared alias order", () => {
    const path = keyFile("gemini-priority.key")
    const found = Providers.compatibleKey("gemini", {
      GEMINI_API_KEY_FILE: join(root, "missing"),
      GOOGLE_API_KEY: "synthetic-direct-key"
    })
    expect(found?.key === "synthetic-direct-key").toBe(true)
    expect(found?.variable).toBe("GOOGLE_API_KEY")
    const file = Providers.compatibleKey("gemini", { GEMINI_API_KEY: "", GEMINI_API_KEY_FILE: path })
    expect(file?.key === "synthetic-provider-key").toBe(true)
    expect(file?.variable).toBe("GEMINI_API_KEY_FILE")
    expect(Providers.compatibleKey("unknown", { AI_GATEWAY_API_KEY_FILE: path })).toBeUndefined()
    expect(Providers.compatibleKey("vercel", { AI_GATEWAY_API_KEY_FILE: "" })).toBeUndefined()
  })

  it.each([0o644, 0o640, 0o604, 0o620, 0o602, 0o700, 0o000])(
    "refuses key permissions %s without revealing content or the path",
    (mode) => {
      const path = keyFile(`permissions-${mode}.key`, "synthetic-private-error-detail\n", mode)
      let failure: unknown
      try {
        Providers.compatibleKey("vercel", { AI_GATEWAY_API_KEY_FILE: path })
      } catch (error) {
        failure = error
      }
      expect(failure).toMatchObject({ code: "provider_key_file_unavailable" })
      const diagnostic = String(failure) + JSON.stringify(failure)
      expect(diagnostic).toContain("AI_GATEWAY_API_KEY_FILE")
      expect(diagnostic.includes("synthetic-private-error-detail")).toBe(false)
      expect(diagnostic.includes(path)).toBe(false)
    }
  )

  it.each(["", "\n", "synthetic-key\n\n", "synthetic-key other", "synthetic-key\u0000", "k".repeat(16385)])(
    "refuses empty, malformed or oversized key contents (case %#)",
    (contents) => {
      const path = keyFile("malformed.key", contents)
      expect(() => Providers.compatibleKey("vercel", { AI_GATEWAY_API_KEY_FILE: path }))
        .toThrow("AI_GATEWAY_API_KEY_FILE")
    }
  )

  it("reads a read-only key, strips one newline, and rereads rotations", () => {
    const path = keyFile("rotation.key", "synthetic-first-key\r\n", 0o400)
    const env = { AI_GATEWAY_API_KEY_FILE: path }
    expect(Providers.compatibleKey("vercel", env)?.key === "synthetic-first-key").toBe(true)
    chmodSync(path, 0o600)
    writeFileSync(path, "synthetic-next-key")
    expect(Providers.compatibleKey("vercel", env)?.key === "synthetic-next-key").toBe(true)
  })

  it("refuses missing files, directories and symlinks without a silent alias fallback", () => {
    const path = keyFile("symlink-target.key")
    const link = join(root, "key-link")
    symlinkSync(path, link)
    for (const bad of [join(root, "missing-file"), root, link]) {
      expect(() => Providers.compatibleKey("gemini", { GEMINI_API_KEY_FILE: bad, GOOGLE_API_KEY_FILE: path }))
        .toThrow("GEMINI_API_KEY_FILE")
    }
  })
})

describe("provider file authentication boundary (#4300)", () => {
  it.each([
    ["vercel", "AI_GATEWAY_API_KEY", "openai/fixture", "/v1/chat/completions"],
    ["openai", "OPENAI_API_KEY", "fixture", "/v1/responses"],
    ["openrouter", "OPENROUTER_API_KEY", "openai/fixture", "/v1/responses"],
    ["anthropic", "ANTHROPIC_API_KEY", "fixture", "/v1/messages"]
  ])(
    "authenticates %s over HTTP without keys in logs or child environments",
    async (provider, variable, model, endpoint) => {
      const path = join(root, `${provider}-call.key`)
      const secret = "synthetic-gateway-request-key"
      writeFileSync(path, `${secret}\n`, { mode: 0o600 })
      const received: Array<{ authenticated: boolean; path: string }> = []
      const server = createServer((request, response) => {
        const authenticated = provider === "anthropic"
          ? request.headers["x-api-key"] === secret
          : request.headers.authorization === `Bearer ${secret}`
        received.push({ authenticated, path: request.url! })
        request.resume()
        if (!authenticated) {
          response.writeHead(401).end("unauthorized")
          return
        }
        response.writeHead(200, { "content-type": "text/event-stream" })
        const frames = provider === "anthropic" ?
          [
            { type: "message_start", message: { id: "fixture" } },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "authenticated" } },
            { type: "content_block_stop", index: 0 },
            { type: "message_delta", delta: { stop_reason: "end_turn" } },
            { type: "message_stop" }
          ] :
          [
            {
              type: "response.output_text.delta",
              item_id: "fixture",
              output_index: 0,
              content_index: 0,
              delta: "authenticated"
            },
            { type: "response.completed", response: { id: "fixture", status: "completed" } }
          ]
        response.end(
          provider === "vercel" ?
            [
              `data: ${
                JSON.stringify({
                  id: "fixture",
                  choices: [{ index: 0, delta: { role: "assistant", content: "authenticated" }, finish_reason: null }]
                })
              }`,
              `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
              "data: [DONE]",
              ""
            ].join("\n\n") :
            frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")
        )
      })
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
      try {
        const address = server.address()
        if (address === null || typeof address === "string") throw new Error("server did not bind")
        const env = Object.freeze({
          [`${variable}_FILE`]: path,
          SMITHERS_MODEL_PROXY_URL: `http://127.0.0.1:${address.port}/api/model`,
          SMITHERS_MODEL_PROXY_PROVIDERS: provider
        })
        const logs: Array<unknown> = []
        const events = await Effect.runPromise(
          Effect.scoped(Effect.gen(function*() {
            const executor = yield* RequestExecutor.make
            const seat = yield* NodeControl.seatResolver(env, executor).resolve(`${provider}:${model}`)
            const request = ModelRequest.ModelRequest.make({
              modelId: seat.modelId,
              system: [],
              messages: [],
              tools: [],
              params: ModelRequest.GenerationParams.make()
            })
            return yield* seat.model.stream(request).pipe(Stream.runCollect)
          })).pipe(
            Effect.provide(FetchHttpClient.layer),
            Effect.provideService(References.MinimumLogLevel, "Trace"),
            Effect.provide(Logger.layer([Logger.map(Logger.formatJson, (entry) => {
              logs.push(entry)
            })], { mergeWithExisting: false }))
          )
        )
        expect(received).toEqual([{ authenticated: true, path: `/api/model/${provider}${endpoint}` }])
        expect(events.some((event) => event.type === "settle")).toBe(true)
        expect(JSON.stringify(events).includes(secret)).toBe(false)
        expect(JSON.stringify(logs).includes(secret)).toBe(false)
        const child = execFileSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], {
          env,
          encoding: "utf8"
        })
        expect(child.includes(secret)).toBe(false)
        expect(JSON.parse(child)[variable]).toBeUndefined()
      } finally {
        await new Promise<void>((done, fail) => server.close((error) => error ? fail(error) : done()))
      }
    }
  )
})

describe("provider file detection (#4300)", () => {
  it.each([
    ["kimi-k3", "MOONSHOT_API_KEY"],
    ["openai", "OPENAI_API_KEY"],
    ["gemini", "GEMINI_API_KEY"],
    ["openrouter", "OPENROUTER_API_KEY"],
    ["cerebras", "CEREBRAS_API_KEY"]
  ])("detects %s from %s_FILE without including the key in metadata", (id, variable) => {
    const path = join(root, `detect-${variable}.key`)
    writeFileSync(path, "synthetic-detected-key\n", { mode: 0o600 })
    const detections = Providers.detect({
      environment: { [`${variable}_FILE`]: path },
      homeDirectory: root,
      readFile: (path) => readFileSync(path, "utf8")
    })
    expect(detections.find((entry) => entry.id === id)).toMatchObject({
      available: true,
      environment: {},
      reason: `$${variable}_FILE is set`
    })
    expect(Providers.chooseSeat(detections)).toMatchObject({ source: id, environment: {} })
    expect(JSON.stringify(detections).includes("synthetic-detected-key")).toBe(false)
  })

  it("reports unsafe key files without exposing their contents or selecting the seat", () => {
    const path = join(root, "unsafe-detection.key")
    writeFileSync(path, "synthetic-detected-key\n", { mode: 0o644 })
    const detections = Providers.detect({
      environment: { GEMINI_API_KEY_FILE: path },
      homeDirectory: root,
      readFile: (path) => readFileSync(path, "utf8")
    })
    expect(detections.find((entry) => entry.id === "gemini")).toMatchObject({
      available: false,
      reason: expect.stringContaining("GEMINI_API_KEY_FILE")
    })
    const diagnostic = Providers.noSeatMessage(detections)
    expect(diagnostic.includes(path)).toBe(false)
    expect(diagnostic.includes("synthetic-detected-key")).toBe(false)
  })

  it("keeps an explicit Anthropic key file on the API rather than a subscription", async () => {
    const path = join(root, "anthropic.key")
    writeFileSync(path, "synthetic-anthropic-key\n", { mode: 0o600 })
    const found = await Providers.claudeCode({
      environment: { ANTHROPIC_API_KEY_FILE: path },
      homeDirectory: root,
      readFile: (path) => readFileSync(path, "utf8")
    })
    expect(found).toMatchObject({
      available: false,
      reason: "$ANTHROPIC_API_KEY_FILE is set, so Claude seats run on the API"
    })
    expect(JSON.stringify(found).includes("synthetic-anthropic-key")).toBe(false)
  })
})

describe("native provider file consumers (#4300)", () => {
  it.each([
    ["OPENAI_API_KEY", "openai:fixture"],
    ["ANTHROPIC_API_KEY", "anthropic:fixture"],
    ["OPENROUTER_API_KEY", "openrouter:fixture"]
  ])("resolves %s from its file and returns a typed refusal for unsafe files", async (variable, name) => {
    const path = join(root, `${variable}.native.key`)
    writeFileSync(path, "synthetic-native-key\n", { mode: 0o600 })
    const resolve = () =>
      Effect.scoped(Effect.gen(function*() {
        const executor = yield* RequestExecutor.make
        return yield* NodeControl.seatResolver({ [`${variable}_FILE`]: path }, executor).resolve(name)
      })).pipe(Effect.provide(FetchHttpClient.layer))
    expect((await Effect.runPromise(resolve())).id).toBe(name)
    chmodSync(path, 0o644)
    const result = await Effect.runPromise(Effect.result(resolve()))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("@smthrs/agent/Seat/SeatUnresolved")
      expect(result.failure.message).toContain(`${variable}_FILE`)
      expect(result.failure.message).not.toContain("synthetic-native-key")
    }
  })

  it("authenticates Jev with its file and refuses an unsafe file without fallback", async () => {
    const path = join(root, "jev.key"), secret = "synthetic-jev-file-key"
    writeFileSync(path, `${secret}\n`, { mode: 0o600 })
    const received: boolean[] = []
    const server = createServer((request, response) => {
      received.push(request.headers.authorization === `Bearer ${secret}`)
      request.resume()
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ answers: { complete: { type: "boolean", probability: 0.9 } } }))
    })
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
    try {
      const address = server.address()
      if (address === null || typeof address === "string") throw new Error("server did not bind")
      const judge = () =>
        Effect.flatMap(Evaluator.Evaluator, (evaluator) =>
          evaluator.evaluate({
            state: "proof",
            questions: { complete: Evaluator.BooleanQuestion.of({ instructions: "Complete?" }) }
          })).pipe(Effect.provide(
            layerSeatEvaluator({
              AI_GATEWAY_API_KEY_FILE: path,
              SMITHERS_EVALUATOR_BASE_URL: `http://127.0.0.1:${address.port}`
            }, FetchHttpClient.layer).pipe(
              Layer.provide(
                Layer.effect(RequestExecutor.RequestExecutor, RequestExecutor.make).pipe(
                  Layer.provide(FetchHttpClient.layer)
                )
              )
            )
          ))
      expect((await Effect.runPromise(judge())).answers.complete).toEqual({ type: "boolean", probability: 0.9 })
      expect(received).toEqual([true])
      chmodSync(path, 0o644)
      const result = await Effect.runPromise(Effect.result(judge()))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure.code).toBe("unconfigured")
        expect(result.failure.message).toContain("AI_GATEWAY_API_KEY_FILE")
        expect(result.failure.message).not.toContain(secret)
      }
      expect(received).toEqual([true])
    } finally {
      await new Promise<void>((done, fail) => server.close((error) => error ? fail(error) : done()))
    }
  })
})

it("pins local subscriptions without reading ambient provider key files", async () => {
  const accounts = join(root, "accounts"),
    claude = join(accounts, "claude-fixture"),
    codex = join(accounts, "codex-fixture")
  mkdirSync(claude, { recursive: true })
  mkdirSync(codex, { recursive: true })
  const access = `eyJhbGciOiJub25lIn0.${
    Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")
  }.signature`
  writeFileSync(
    join(codex, "auth.json"),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: access, refresh_token: "synthetic-refresh", account_id: "synthetic-account" }
    }),
    { mode: 0o600 }
  )
  const path = join(root, "ambient.key")
  writeFileSync(path, "synthetic-ambient-key", { mode: 0o600 })
  const resolve = (env: Record<string, string>, seat: string) =>
    Effect.scoped(Effect.gen(function*() {
      const executor = yield* RequestExecutor.make
      return yield* NodeControl.seatResolver({ PATH: "", SMITHERS_ACCOUNTS_DIR: accounts, ...env }, executor).resolve(
        seat
      )
    })).pipe(Effect.provide(FetchHttpClient.layer))
  const claudeResult = await Effect.runPromise(
    Effect.result(resolve({ ANTHROPIC_API_KEY_FILE: path }, "opus@claude-fixture"))
  )
  expect(claudeResult._tag).toBe("Failure")
  if (claudeResult._tag === "Failure") expect(claudeResult.failure.message).toContain("Claude Code is not installed")
  chmodSync(path, 0o644)
  expect((await Effect.runPromise(resolve({ OPENAI_API_KEY_FILE: path }, "sol@codex-fixture"))).id).toBe(
    "sol@codex-fixture"
  )
  expect(
    (await Effect.runPromise(
      resolve({ OPENAI_API_KEY_FILE: path, CODEX_HOME: codex, SMITHERS_OPENAI_AUTH: "chatgpt" }, "openai:fixture")
    )).id
  ).toBe("openai:fixture")
})

it("keeps other automatic seats available when a provider key file is unsafe", async () => {
  const path = join(root, "catalog.key")
  writeFileSync(path, "synthetic-catalog-key", { mode: 0o644 })
  const host = {
    environment: { OPENAI_API_KEY: "synthetic-openai-key", ANTHROPIC_API_KEY_FILE: path },
    homeDirectory: root,
    readFile: () => undefined
  }
  expect(await NodeControl.seatCandidates(host)).toEqual(["luna", "sol"])
  expect(
    await NodeControl.seatCandidates({
      ...host,
      environment: {
        ...host.environment,
        SMITHERS_ACCOUNT_POOL_URL: "https://pool.example",
        SMITHERS_ACCOUNT_POOL_KEY: "synthetic-pool",
        SMITHERS_ACCOUNT_POOL_PROVIDERS: "anthropic"
      }
    })
  ).toEqual(expect.arrayContaining(["luna", "sol", "opus", "fable", "sonnet"]))
})
