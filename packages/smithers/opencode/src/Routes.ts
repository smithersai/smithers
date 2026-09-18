/**
 * Every OpenCode protocol v1 route the hosted app calls, with the response
 * shapes of the 1.18.31 OpenAPI document, over one directory.
 *
 * The bootstrap routes describe one project (the served directory), one
 * provider with one model (the seat), and one agent (`smithers`). The
 * session routes read the store. The prompt, abort, and permission routes
 * hand off to `Turns`. The event routes stream the hub. Everything OpenCode
 * has that this server does not (commands, MCP, LSP, todos, children,
 * diffs) answers empty, which the app tolerates.
 *
 * Three v2 routes answer too, because the app calls them in v1 mode:
 * `/api/health` (polled every ten seconds), `/api/session` (the home list)
 * and `/api/reference`.
 *
 * @since 1.0.0
 */
import { Effect, type Layer, Option, Stream } from "effect"
import { HttpRouter, type HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join, relative, resolve, sep } from "node:path"
import * as Events from "./Events.ts"
import * as Health from "./Health.ts"
import * as Ids from "./Ids.ts"
import * as Protocol from "./Protocol.ts"
import * as Store from "./Store.ts"
import * as Turns from "./Turns.ts"

/**
 * How the routes describe the server.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  /** The served directory, absolute. */
  readonly directory: string
  /** What `/global/health` reports and every session is stamped with. */
  readonly version: string
  /** The seat, as `provider:model`. */
  readonly seat: string
  /** The one agent's name. */
  readonly agent: string
}

/**
 * The project id of a directory: a stable hash of its absolute path, the
 * way OpenCode derives one for a directory without a git root.
 *
 * @category constructors
 * @since 1.0.0
 */
export const projectID = (directory: string): string => createHash("sha1").update(resolve(directory)).digest("hex")

/**
 * The provider and model of a seat string.
 *
 * @category conversions
 * @since 1.0.0
 */
export const modelOf = (seat: string): Protocol.ModelRef => {
  const index = seat.indexOf(":")
  return index < 0
    ? { providerID: "smithers", modelID: seat }
    : { providerID: seat.slice(0, index), modelID: seat.slice(index + 1) }
}

/**
 * The slug of a new session: two words from its id, which is enough for the
 * app to label it before the first prompt names it.
 *
 * @category constructors
 * @since 1.0.0
 */
export const slugOf = (id: string): string => {
  const adjectives = ["quiet", "bright", "steady", "brisk", "calm", "keen", "plain", "swift"]
  const nouns = ["harbor", "meadow", "signal", "ledger", "beacon", "kernel", "orchard", "compass"]
  const tail = id.slice(-4)
  const a = adjectives[tail.charCodeAt(0) % adjectives.length]!
  const b = nouns[tail.charCodeAt(1) % nouns.length]!
  return `${a}-${b}`
}

/**
 * The one provider entry `/provider` lists: the seat as a model with every
 * field the app reads (`Model` in the OpenAPI, all required).
 *
 * @category constructors
 * @since 1.0.0
 */
export const provider = (seat: string): Record<string, unknown> => {
  const model = modelOf(seat)
  const flags = { text: true, audio: false, image: false, video: false, pdf: false }
  return {
    id: model.providerID,
    name: model.providerID,
    source: "env",
    env: [],
    options: {},
    models: {
      [model.modelID]: {
        id: model.modelID,
        providerID: model.providerID,
        api: { id: model.modelID, url: "", npm: "" },
        name: model.modelID,
        capabilities: {
          temperature: true,
          reasoning: false,
          attachment: false,
          toolcall: true,
          input: flags,
          output: flags,
          interleaved: false
        },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: { context: 128000, output: 16000 },
        status: "active",
        options: {},
        headers: {},
        release_date: "2026-01-01",
        variants: {}
      }
    }
  }
}

/**
 * The one agent `/agent` lists.
 *
 * @category constructors
 * @since 1.0.0
 */
export const agent = (name: string, seat: string): Record<string, unknown> => ({
  name,
  description: "The Smithers cell loop: the model writes JavaScript cells and reaches the world through ctx.call.",
  mode: "primary",
  native: true,
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
  model: modelOf(seat),
  options: {}
})

/**
 * The branch a git checkout is on, read from `.git/HEAD`, or `undefined`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const gitBranch = (directory: string): string | undefined => {
  try {
    const head = readFileSync(join(directory, ".git", "HEAD"), "utf8").trim()
    const match = /^ref: refs\/heads\/(.+)$/.exec(head)
    return match === null ? head.slice(0, 12) : match[1]
  } catch {
    return undefined
  }
}

/**
 * The entries of a directory, as `/file` lists them: `path` relative to
 * `directory`. The app's project picker walks from the home directory with
 * this route, one typed segment at a time, so the base is whatever the app
 * names, the way OpenCode's own server answers it. A directory whose name
 * starts with a dot (`.git`, `.smithers`) is left out, so the picker does
 * not offer to open the project there.
 *
 * @category constructors
 * @since 1.0.0
 */
export const listFiles = (directory: string, path: string): Array<Protocol.FileNode> => {
  const target = resolve(directory, path)
  try {
    return readdirSync(target, { withFileTypes: true })
      .filter((entry) => entry.isFile() || (entry.isDirectory() && !entry.name.startsWith(".")))
      .map((entry): Protocol.FileNode => {
        const absolute = join(target, entry.name)
        const type = entry.isDirectory() ? "directory" : "file"
        return {
          name: entry.name,
          path: `${relative(directory, absolute)}${type === "directory" ? "/" : ""}`,
          absolute,
          type,
          ignored: entry.name === ".git" || entry.name === "node_modules" || entry.name === ".smithers"
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

/**
 * A file's content, as `/file/content` answers it: `text` with the bytes
 * decoded, or `binary` with no content when the head of the file holds a
 * NUL byte. `undefined` when `path` does not name a regular file under
 * `directory`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const fileContent = (directory: string, path: string): Protocol.FileContent | undefined => {
  const base = resolve(directory)
  const target = resolve(base, path)
  if (!target.startsWith(base + sep)) return undefined
  try {
    if (!statSync(target).isFile()) return undefined
    const bytes = readFileSync(target)
    return bytes.subarray(0, 8192).includes(0)
      ? { type: "binary", content: "" }
      : { type: "text", content: bytes.toString("utf8") }
  } catch {
    return undefined
  }
}

const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status })

const notFound = (message: string) => json({ name: "NotFoundError", data: { message } }, 404)

const badRequest = (message: string) => json({ name: "BadRequestError", data: { message } }, 400)

const failed = (message: string) => json({ name: "UnknownError", data: { message } }, 500)

const query = (request: HttpServerRequest.HttpServerRequest): URLSearchParams =>
  new URL(request.url, "http://localhost").searchParams

const body = (request: HttpServerRequest.HttpServerRequest): Effect.Effect<Record<string, unknown>> =>
  request.json.pipe(
    Effect.map((value): Record<string, unknown> => isRecord(value) && !Array.isArray(value) ? value : {}),
    // A body that is not JSON is an empty body; a read failure is a request failure, not a server one.
    Effect.catch(() => Effect.succeed({}))
  )

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

/**
 * Mounts every route. Needs the store, the hub, and the turns.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (
  options: Options
): Layer.Layer<never, never, HttpRouter.HttpRouter | Store.Store | Events.Events | Turns.Turns> =>
  HttpRouter.use((router) =>
    Effect.gen(function*() {
      const store = yield* Store.Store
      const hub = yield* Events.Events
      const turns = yield* Turns.Turns
      const directory = resolve(options.directory)
      const project = projectID(directory)
      const model = modelOf(options.seat)
      const now = () => Date.now()
      const bootAt = now()

      const projectInfo = (): Protocol.Project => ({
        id: project,
        worktree: directory,
        ...(existsSync(join(directory, ".git")) ? { vcs: "git" } : {}),
        time: { created: bootAt, updated: now() },
        sandboxes: []
      })

      const onStoreError = (error: Store.StoreError) => Effect.succeed(failed(error.message))

      /** Runs a store read and answers 500 on a store failure. */
      const stored = <A>(
        effect: Effect.Effect<A, Store.StoreError>,
        answer: (value: A) => HttpServerResponse.HttpServerResponse
      ) => effect.pipe(Effect.map(answer), Effect.catchTag("@smthrs/opencode/StoreError", onStoreError))

      const withSession = (
        id: string,
        answer: (session: Protocol.Session) => Effect.Effect<HttpServerResponse.HttpServerResponse, Store.StoreError>
      ) =>
        store.getSession(id).pipe(
          Effect.flatMap((session) =>
            Option.isNone(session) ? Effect.succeed(notFound(`Session ${id} not found`)) : answer(session.value)
          ),
          Effect.catchTag("@smthrs/opencode/StoreError", onStoreError)
        )

      const sessionParam = Effect.map(HttpRouter.params, (params) => params["id"]!)

      // `/global/event` carries the `{directory, project, payload}` envelope
      // the app folds; `/event` carries the bare `Event` of the OpenAPI, which
      // is what the SDK's `event.subscribe` and the TUI read.
      const sse = (request: HttpServerRequest.HttpServerRequest, bare = false) =>
        HttpServerResponse.stream(Stream.encodeText(hub.stream({ after: request.headers["last-event-id"], bare })), {
          contentType: "text/event-stream",
          headers: {
            "cache-control": "no-cache, no-transform",
            // The socket closes with the stream: a shutdown that ends the
            // streams is not then held by an idle keep-alive connection.
            connection: "close",
            "x-accel-buffering": "no",
            "x-content-type-options": "nosniff"
          }
        })

      // Health, in both generations.
      yield* router.add("GET", "/global/health", json({ healthy: true, version: options.version }))
      yield* router.add("GET", "/api/health", json({ healthy: true }))

      // The bootstrap: one project, one provider, one agent.
      yield* router.add("GET", "/global/config", json({ $schema: "https://opencode.ai/config.json" }))
      yield* router.add(
        "GET",
        "/config",
        json({
          $schema: "https://opencode.ai/config.json",
          model: `${model.providerID}/${model.modelID}`,
          default_agent: options.agent,
          username: basename(homedir()),
          command: {},
          plugin: [],
          mode: {},
          agent: {},
          mcp: {},
          permission: {}
        })
      )
      yield* router.add(
        "GET",
        "/path",
        Effect.sync(() =>
          json({
            home: homedir(),
            state: join(homedir(), ".local", "state", "smithers"),
            config: join(homedir(), ".config", "smithers"),
            worktree: directory,
            directory
          })
        )
      )
      yield* router.add("GET", "/project", Effect.sync(() => json([projectInfo()])))
      yield* router.add("GET", "/project/current", Effect.sync(() => json(projectInfo())))
      yield* router.add(
        "PATCH",
        "/project/:id",
        (request) =>
          Effect.gen(function*() {
            const params = yield* HttpRouter.params
            if (params["id"] !== project) return notFound(`Project ${params["id"]} not found`)
            // A rename from the app: the name rides on the answer, the
            // directory stays what it is.
            const input = yield* body(request)
            const name = input["name"]
            return json({ ...projectInfo(), ...(typeof name === "string" ? { name } : {}) })
          })
      )
      yield* router.add(
        "GET",
        "/provider",
        json({
          all: [provider(options.seat)],
          connected: [model.providerID],
          default: { [model.providerID]: model.modelID }
        })
      )
      yield* router.add("GET", "/agent", json([agent(options.agent, options.seat)]))
      yield* router.add("GET", "/command", json([]))
      yield* router.add("GET", "/lsp", json([]))
      yield* router.add("GET", "/mcp", json({}))
      yield* router.add("GET", "/experimental/resource", json({}))
      yield* router.add("GET", "/question", json([]))
      yield* router.add(
        "GET",
        "/vcs",
        Effect.sync(() => {
          const branch = gitBranch(directory)
          return json(branch === undefined ? {} : { branch, default_branch: branch })
        })
      )
      yield* router.add("GET", "/vcs/diff", json([]))
      yield* router.add("GET", "/vcs/status", json([]))
      yield* router.add(
        "GET",
        "/find/file",
        (request) => {
          // The app's project picker asks for directories matching what the
          // person typed; the one directory this server serves is the answer
          // when the typed prefix leads to it.
          const params = query(request)
          const typed = resolve(params.get("directory") ?? directory, params.get("query") ?? "")
          const matches = params.get("dirs") === "true" && directory.startsWith(typed)
          return Effect.succeed(json(matches ? [directory] : []))
        }
      )
      yield* router.add(
        "GET",
        "/file",
        (request) => {
          const params = query(request)
          return Effect.sync(() => json(listFiles(params.get("directory") ?? directory, params.get("path") ?? "")))
        }
      )
      yield* router.add(
        "GET",
        "/file/content",
        (request) => {
          const params = query(request)
          const path = params.get("path") ?? ""
          return Effect.sync(() => {
            const content = fileContent(params.get("directory") ?? directory, path)
            return content === undefined ? notFound(`File ${path} not found`) : json(content)
          })
        }
      )
      yield* router.add(
        "GET",
        "/api/reference",
        json({ location: { directory, project: { id: project, directory } }, data: [] })
      )

      // Pending permissions and busy sessions.
      yield* router.add(
        "GET",
        "/permission",
        stored(store.listPermissions(), (pending) => json(pending))
      )
      yield* router.add("GET", "/session/status", Effect.map(turns.status(), (status) => json(status)))

      // Sessions.
      yield* router.add(
        "GET",
        "/api/session",
        (request) =>
          stored(store.listSessions(), (sessions) => {
            const params = query(request)
            const limit = Number(params.get("limit") ?? "5000")
            const wanted = params.get("directory")
            const data = sessions
              .filter((session) => wanted === null || session.directory === wanted)
              .filter((session) => session.time.archived === undefined)
              .slice(0, Number.isFinite(limit) && limit > 0 ? limit : sessions.length)
              .map(Protocol.toSessionV2)
            return json({ data, cursor: {} })
          })
      )
      yield* router.add(
        "GET",
        "/session",
        (request) =>
          stored(store.listSessions(), (sessions) => {
            const params = query(request)
            const limit = Number(params.get("limit") ?? "55")
            return json(
              sessions
                .filter((session) => session.time.archived === undefined)
                .slice(0, Number.isFinite(limit) && limit > 0 ? limit : sessions.length)
            )
          })
      )
      yield* router.add(
        "POST",
        "/session",
        (request) =>
          Effect.gen(function*() {
            const input = yield* body(request)
            const at = now()
            const id = Ids.make("session", at)
            const title = typeof input["title"] === "string"
              ? input["title"]
              : `New session - ${new Date(at).toISOString()}`
            const session: Protocol.Session = {
              id,
              slug: slugOf(id),
              projectID: project,
              directory,
              path: "",
              title,
              version: options.version,
              agent: typeof input["agent"] === "string" ? input["agent"] : options.agent,
              model: { id: model.modelID, providerID: model.providerID },
              cost: 0,
              tokens: Protocol.noTokens,
              time: { created: at, updated: at }
            }
            yield* store.putSession(session)
            yield* hub.publish({ type: "session.created", properties: { sessionID: id, info: session } })
            return json(session)
          }).pipe(Effect.catchTag("@smthrs/opencode/StoreError", onStoreError))
      )
      yield* router.add(
        "GET",
        "/session/:id",
        Effect.flatMap(sessionParam, (id) => withSession(id, (session) => Effect.succeed(json(session))))
      )
      yield* router.add(
        "PATCH",
        "/session/:id",
        (request) =>
          Effect.flatMap(sessionParam, (id) =>
            withSession(id, (session) =>
              Effect.gen(function*() {
                const input = yield* body(request)
                const time = isRecord(input["time"]) ? input["time"] : {}
                const archived = typeof time["archived"] === "number" ? time["archived"] : undefined
                // A rename keeps the health dot in front of the person's
                // words, and drops the dot the app echoes back at the front
                // of them; an archive drops the dot.
                const renamed = typeof input["title"] === "string"
                  ? Health.retitle(session.title, input["title"])
                  : session.title
                const updated: Protocol.Session = {
                  ...session,
                  title: archived === undefined ? renamed : Health.strip(renamed),
                  time: {
                    ...session.time,
                    updated: now(),
                    ...(archived === undefined ? {} : { archived })
                  }
                }
                yield* store.putSession(updated)
                yield* hub.publish({ type: "session.updated", properties: { sessionID: id, info: updated } })
                return json(updated)
              })))
      )
      yield* router.add(
        "DELETE",
        "/session/:id",
        Effect.flatMap(sessionParam, (id) =>
          withSession(id, (session) =>
            Effect.gen(function*() {
              yield* turns.abort(id)
              yield* store.deleteSession(id)
              yield* hub.publish({ type: "session.deleted", properties: { sessionID: id, info: session } })
              return json(true)
            })))
      )
      yield* router.add(
        "GET",
        "/session/:id/message",
        (request) =>
          Effect.flatMap(sessionParam, (id) =>
            withSession(id, () => {
              // The way 1.18.31 pages: no limit is the whole history; a
              // limit is a page, and when more remain the answer names the
              // cursor (the oldest id on the page) in `X-Next-Cursor` and a
              // `Link` (relative, so no host is guessed), exposed so the app
              // can read them and load older messages on scroll.
              const params = query(request)
              const limit = Number(params.get("limit") ?? "0")
              const before = params.get("before") ?? undefined
              const page = Number.isFinite(limit) && limit > 0 ? limit : undefined
              return Effect.map(
                store.listMessages(id, { limit: page === undefined ? Number.MAX_SAFE_INTEGER : page + 1, before }),
                (messages) => {
                  if (page === undefined || messages.length <= page) return json(messages)
                  const items = messages.slice(1)
                  const cursor = items[0]!.info.id
                  const next = new URL(request.url, "http://localhost")
                  next.searchParams.set("limit", String(page))
                  next.searchParams.set("before", cursor)
                  return json(items).pipe(HttpServerResponse.setHeaders({
                    "access-control-expose-headers": "Link, X-Next-Cursor",
                    link: `<${next.pathname}${next.search}>; rel="next"`,
                    "x-next-cursor": cursor
                  }))
                }
              )
            }))
      )
      yield* router.add(
        "GET",
        "/session/:id/message/:messageID",
        Effect.flatMap(HttpRouter.params, (params) =>
          withSession(params["id"]!, (session) =>
            Effect.gen(function*() {
              const messageID = params["messageID"]!
              const message = yield* store.getMessage(messageID)
              if (Option.isNone(message) || message.value.sessionID !== session.id) {
                return notFound(`Message ${messageID} not found`)
              }
              return json({ info: message.value, parts: yield* store.listParts(messageID) })
            })))
      )
      yield* router.add("GET", "/session/:id/todo", json([]))
      yield* router.add("GET", "/session/:id/children", json([]))
      yield* router.add("GET", "/session/:id/diff", json([]))
      yield* router.add(
        "POST",
        "/session/:id/prompt_async",
        (request) =>
          Effect.flatMap(sessionParam, (id) =>
            Effect.gen(function*() {
              const input = yield* body(request)
              const parts = Array.isArray(input["parts"])
                ? input["parts"].filter(isRecord).map((part) => ({
                  id: typeof part["id"] === "string" ? part["id"] : undefined,
                  type: typeof part["type"] === "string" ? part["type"] : "",
                  text: typeof part["text"] === "string" ? part["text"] : undefined
                }))
                : []
              const wanted = isRecord(input["model"]) ? input["model"] : undefined
              yield* turns.prompt({
                sessionID: id,
                messageID: typeof input["messageID"] === "string" ? input["messageID"] : undefined,
                agent: typeof input["agent"] === "string" ? input["agent"] : undefined,
                model: wanted !== undefined && typeof wanted["providerID"] === "string" &&
                    typeof wanted["modelID"] === "string"
                  ? { providerID: wanted["providerID"], modelID: wanted["modelID"] }
                  : undefined,
                parts
              })
              return HttpServerResponse.empty({ status: 204 })
            }).pipe(
              Effect.catchTags({
                "@smthrs/opencode/TurnsError": (error) =>
                  Effect.succeed(
                    error.code === "unknown_session" ? notFound(error.message) : badRequest(error.message)
                  ),
                "@smthrs/opencode/StoreError": onStoreError
              })
            ))
      )
      yield* router.add(
        "POST",
        "/session/:id/abort",
        Effect.flatMap(sessionParam, (id) => Effect.map(turns.abort(id), (aborted) => json(aborted)))
      )
      yield* router.add(
        "POST",
        "/session/:id/permissions/:permissionID",
        (request) =>
          Effect.gen(function*() {
            const params = yield* HttpRouter.params
            const input = yield* body(request)
            const response = input["response"]
            if (response !== "once" && response !== "always" && response !== "reject") {
              return badRequest("response must be once, always or reject")
            }
            yield* turns.permission({
              sessionID: params["id"]!,
              permissionID: params["permissionID"]!,
              response
            })
            return json(true)
          }).pipe(
            Effect.catchTags({
              "@smthrs/opencode/TurnsError": (error) => Effect.succeed(notFound(error.message)),
              "@smthrs/opencode/StoreError": onStoreError
            })
          )
      )

      // The streams.
      yield* router.add("GET", "/global/event", (request) => Effect.succeed(sse(request)))
      yield* router.add("GET", "/event", (request) => Effect.succeed(sse(request, true)))
    })
  )
