/**
 * A language server in a dedicated Web Worker, binding `@smthrs/std`'s
 * `LanguageServer`: TypeScript's language service over a read-only
 * workspace, such as a repository at a commit, whose files the tab supplies.
 *
 * - {@link serve} is the worker entry. The page's worker module hands it the
 *   TypeScript compiler API and a loader for TypeScript's `lib.*.d.ts`
 *   files, so this package carries no `typescript` dependency and a page
 *   that never starts the worker never loads either.
 * - {@link make} runs in the tab: it starts the worker, sends it the
 *   workspace's file list, answers the worker's reads with
 *   {@link Workspace.read}, and returns a `LanguageServer` whose answers are
 *   the protocol's own shapes (`Hover`, `Location[]`, `DocumentSymbol[]`,
 *   `SymbolInformation[]` and a full `DocumentDiagnosticReport`), as
 *   `@smthrs/platform-node`'s `NodeLanguageServer` gives them.
 *
 * Paths in requests are absolute within the workspace (`/src/index.ts` for
 * the file list's `src/index.ts`), and every URI in an answer is
 * {@link uriOf} one. A request loads the file and its import closure, and
 * `references` widens the program to every script under the file's
 * `tsconfig.json`, up to 2,000 files and 16 MiB; `workspaceSymbols` searches
 * what is loaded. Diagnostics
 * leave out the errors that only say a package is missing, since a commit
 * holds no `node_modules`. The call-hierarchy requests answer `unsupported`.
 *
 * ```ts
 * // language.worker.ts, the worker module
 * import ts from "typescript"
 * const libs = import.meta.glob<string>("/node_modules/typescript/lib/lib.*.d.ts", { query: "?raw", import: "default" })
 * BrowserLanguageServer.serve({
 *   typescript: ts,
 *   lib: (name) => libs[`/node_modules/typescript/lib/${name}`]?.() ?? Promise.resolve(undefined)
 * })
 *
 * // the tab
 * const server = yield* BrowserLanguageServer.make({
 *   worker: () => new Worker(new URL("./language.worker.ts", import.meta.url), { type: "module" }),
 *   workspace: { paths, read: (path) => readAtCommit(path) }
 * })
 * const hover = yield* server.hover({ path: "/src/index.ts", line: 3, character: 9 })
 * ```
 *
 * @since 1.0.0
 */

import { LanguageServer, StdError } from "@smthrs/std"
import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Metric from "effect/Metric"
import * as Queue from "effect/Queue"
import type * as Scope from "effect/Scope"
import * as BrowserScheduler from "./BrowserScheduler.ts"
import type * as Protocol from "./internal/LanguageProtocol.ts"
import * as TypeScriptWorkspace from "./internal/TypeScriptWorkspace.ts"

/**
 * The workspace the server reads: its files' paths, relative to its root,
 * and a way to read one.
 *
 * @category models
 * @since 1.0.0
 */
export interface Workspace {
  /** Every file's path, such as `src/index.ts`. */
  readonly paths: ReadonlyArray<string>
  /**
   * A file's text by its path in {@link paths}; `undefined` for a file that
   * isn't text. A failure reads as `undefined` too.
   */
  readonly read: (path: string) => Effect.Effect<string | undefined, unknown>
}

/**
 * The slice of a `Worker` {@link make} uses.
 *
 * @category models
 * @since 1.0.0
 */
export interface WorkerLike {
  postMessage(message: unknown): void
  terminate(): void
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void
  addEventListener(type: "error", listener: (event: Event) => void): void
}

/**
 * What {@link make} starts.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  /**
   * Starts the worker whose module calls {@link serve}, such as
   * `() => new Worker(new URL("./language.worker.ts", import.meta.url), { type: "module" })`.
   * It is terminated when the scope closes.
   */
  readonly worker: () => WorkerLike
  readonly workspace: Workspace
  /**
   * How long one request may take, loading included. Default 60 seconds:
   * the first request of a workspace pays for TypeScript and its lib files.
   */
  readonly timeout?: Duration.Input | undefined
  /** How many reads run at once. Default 8. */
  readonly concurrency?: number | undefined
}

/**
 * What the worker entry needs: the TypeScript compiler API and TypeScript's
 * `lib.*.d.ts` files by file name, such as `lib.es2022.d.ts`, `undefined`
 * for one that doesn't exist.
 *
 * @category models
 * @since 1.0.0
 */
export interface ServeOptions {
  readonly typescript: TypeScriptWorkspace.TypeScript
  readonly lib: (fileName: string) => Promise<string | undefined>
  /** Where messages arrive and go. Default: the worker's own global scope. */
  readonly port?: Protocol.Port | undefined
  /** The most files and characters one workspace loads. Default 2,000 files and 16 MiB. */
  readonly limits?: Partial<TypeScriptWorkspace.Limits> | undefined
}

/**
 * Requests the tab sent, by `method` and `outcome` (`answered`, or the
 * failure's code).
 *
 * @category metrics
 * @since 1.0.0
 */
export const requests = Metric.counter("smithers_browser_language_server_requests", {
  description: "Requests a tab sent to its browser language server, by method and outcome",
  incremental: true
})

/**
 * How long each request took, in milliseconds, by `method`.
 *
 * @category metrics
 * @since 1.0.0
 */
export const duration = Metric.histogram("smithers_browser_language_server_ms", {
  description: "Milliseconds from a tab's language-server request to its answer, by method",
  boundaries: Metric.exponentialBoundaries({ start: 1, factor: 2, count: 16 })
})

/**
 * Files the tab read for its workers.
 *
 * @category metrics
 * @since 1.0.0
 */
export const files = Metric.counter("smithers_browser_language_server_files", {
  description: "Files a tab read for its browser language servers",
  incremental: true
})

/**
 * An absolute workspace path as the `file:` URI answers name it.
 *
 * @category paths
 * @since 1.0.0
 */
export const uriOf: (path: string) => string = TypeScriptWorkspace.uriOf

/**
 * The absolute workspace path a `file:` URI names, or `undefined` for any
 * other URI or malformed percent encoding.
 *
 * @category paths
 * @since 1.0.0
 */
export const pathOf = (uri: string): string | undefined => {
  if (!uri.startsWith("file:///")) return undefined
  try {
    return uri.slice("file://".length).split("/").map(decodeURIComponent).join("/")
  } catch {
    return undefined
  }
}

/**
 * Whether an absolute path is one of TypeScript's own lib files rather than
 * a workspace file, as a definition in `lib.es5.d.ts` is.
 *
 * @category paths
 * @since 1.0.0
 */
export const isLib = (path: string): boolean => path.startsWith(`${TypeScriptWorkspace.LIB_DIRECTORY}/`)

const unsupported = (method: string) =>
  Effect.fail(
    new StdError.StdError({ code: "unsupported", message: "Not supported by the browser language server", method })
  )

/**
 * Starts the worker and returns its `LanguageServer`. Every request after
 * the worker failed, and every one waiting when it failed, fails with
 * `provider_unavailable`; one that runs past the timeout fails with
 * `timeout`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (options: Options): Effect.Effect<LanguageServer.LanguageServer, never, Scope.Scope> =>
  Effect.gen(function*() {
    const inbox = yield* Queue.unbounded<Protocol.Event>()
    const worker = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const worker = options.worker()
        worker.addEventListener("message", (event) => Queue.offerUnsafe(inbox, { _tag: "Message", data: event.data }))
        // The worker's error event, by its error's name when the browser gives one (often only `ErrorEvent`).
        worker.addEventListener("error", (event) =>
          Queue.offerUnsafe(inbox, {
            _tag: "Failed",
            error: String((event as Partial<ErrorEvent> | undefined)?.error?.name ?? "ErrorEvent")
          }))
        return worker
      }),
      (worker) => Effect.sync(() => worker.terminate())
    )
    const post = (message: Protocol.ToWorker) => Effect.sync(() => worker.postMessage(message))
    yield* post({ _tag: "Open", paths: options.workspace.paths })

    const pending = new Map<number, Deferred.Deferred<Protocol.Answer, StdError.StdError>>()
    let failed: StdError.StdError | undefined
    let next = 0

    const reading = new Map<number, Fiber.Fiber<unknown>>()
    const answerRead = (message: Protocol.ReadMessage) =>
      Effect.forEach(
        message.paths,
        (path) =>
          options.workspace.read(path.slice(1)).pipe(
            Effect.orElseSucceed(() => undefined),
            Effect.map((text) => [path, text ?? null] as const)
          ),
        { concurrency: options.concurrency ?? 8 }
      ).pipe(
        Effect.tap((read) => Metric.update(files, read.length)),
        Effect.flatMap((read) => post({ _tag: "Files", id: message.id, files: read }))
      )

    // Delivers the worker's messages until the worker fails; after that nothing it sends is read.
    yield* Effect.forkScoped(Effect.gen(function*() {
      while (true) {
        const event = yield* Queue.take(inbox)
        if (event._tag === "Failed") {
          const stopped = new StdError.StdError({
            code: "provider_unavailable",
            message: "The language server stopped"
          })
          failed = stopped
          yield* Effect.logError("browser.language_server.failed").pipe(
            Effect.annotateLogs({ "error.type": event.error })
          )
          return yield* Effect.forEach(pending.values(), (waiting) => Deferred.fail(waiting, stopped), {
            discard: true
          })
        }
        const message = event.data as Protocol.FromWorker
        if (message._tag === "Read") {
          reading.set(message.id, yield* Effect.forkScoped(answerRead(message)))
          continue
        }
        if (message._tag === "CancelRead") {
          const fiber = reading.get(message.id)
          reading.delete(message.id)
          if (fiber !== undefined) yield* Fiber.interrupt(fiber)
          continue
        }
        const waiting = pending.get(message.id)
        if (waiting === undefined) continue
        if (message._tag === "Reply") yield* Deferred.succeed(waiting, message)
        else {
          yield* Deferred.fail(
            waiting,
            new StdError.StdError({ code: message.code, message: message.message, method: message.method })
          )
        }
      }
    }))

    const send = (method: Protocol.Method, params: Protocol.Params) =>
      Effect.gen(function*() {
        if (failed !== undefined) return yield* Effect.fail(failed)
        const id = next++
        const answer = yield* Deferred.make<Protocol.Answer, StdError.StdError>()
        pending.set(id, answer)
        yield* post({ _tag: "Request", id, method, params })
        return yield* Deferred.await(answer).pipe(
          Effect.timeoutOrElse({
            duration: options.timeout ?? "60 seconds",
            orElse: () =>
              Effect.fail(
                new StdError.StdError({
                  code: "timeout",
                  message: "The language server did not answer in time",
                  method
                })
              )
          }),
          Effect.ensuring(
            post({ _tag: "Cancel", id }).pipe(
              Effect.andThen(Effect.sync(() => pending.delete(id)))
            )
          )
        )
      })

    const request = (method: Protocol.Method, params: Protocol.Params) =>
      Effect.gen(function*() {
        const startedAt = yield* Clock.currentTimeMillis
        const answer = yield* send(method, params).pipe(
          Effect.tapError((error) => Metric.update(Metric.withAttributes(requests, { method, outcome: error.code }), 1))
        )
        yield* Metric.update(Metric.withAttributes(requests, { method, outcome: "answered" }), 1)
        yield* Metric.update(Metric.withAttributes(duration, { method }), (yield* Clock.currentTimeMillis) - startedAt)
        yield* Effect.annotateCurrentSpan({ files: answer.files, partial: answer.partial })
        return answer.result
      }).pipe(Effect.withSpan(`browser.language_server.${method}`, { attributes: { method } }))

    const position = (method: Protocol.Method) => (at: LanguageServer.Position) =>
      request(method, { path: at.path, line: at.line, character: at.character })

    return LanguageServer.make({
      hover: position("hover"),
      definition: position("definition"),
      references: position("references"),
      implementation: position("implementation"),
      documentSymbols: (path) => request("documentSymbols", { path }),
      workspaceSymbols: (query) => request("workspaceSymbols", { query }),
      prepareCallHierarchy: () => unsupported("prepareCallHierarchy"),
      callHierarchyIncoming: () => unsupported("callHierarchyIncoming"),
      callHierarchyOutgoing: () => unsupported("callHierarchyOutgoing"),
      diagnostics: (path) => request("diagnostics", { path }),
      sync: (path, text) => Effect.asVoid(request("sync", { path, text })),
      close: (path) => Effect.asVoid(request("close", { path })),
      refresh: Effect.void
    })
  })

/**
 * The worker's program: answers the tab's requests one at a time, reading
 * the files each needs from the tab. It runs until the worker ends.
 *
 * @category running
 * @since 1.0.0
 */
export const program = (
  options: ServeOptions & { readonly port: Protocol.Port }
): Effect.Effect<never, never, Scope.Scope> =>
  Effect.gen(function*() {
    const inbox = yield* Queue.unbounded<unknown>()
    const requests = yield* Queue.unbounded<Protocol.RequestMessage>()
    const listener = (event: MessageEvent) => Queue.offerUnsafe(inbox, event.data)
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        options.port.addEventListener("message", listener)
        options.port.start?.()
      }),
      () => Effect.sync(() => options.port.removeEventListener("message", listener))
    )
    const post = (message: Protocol.FromWorker) => Effect.sync(() => options.port.postMessage(message))
    const cancelled = new Map<number, Deferred.Deferred<void>>()
    const reads = new Map<number, Deferred.Deferred<TypeScriptWorkspace.Read>>()
    let nextRead = 0
    const loader: TypeScriptWorkspace.Loader = {
      read: (paths) =>
        Effect.gen(function*() {
          const id = nextRead++
          const answer = yield* Deferred.make<TypeScriptWorkspace.Read>()
          reads.set(id, answer)
          yield* post({ _tag: "Read", id, paths })
          return yield* Deferred.await(answer).pipe(Effect.ensuring(
            Effect.sync(() => reads.delete(id)).pipe(
              Effect.andThen(post({ _tag: "CancelRead", id }))
            )
          ))
        }),
      lib: (fileName) => Effect.tryPromise(() => options.lib(fileName)).pipe(Effect.orElseSucceed(() => undefined))
    }
    let workspace: TypeScriptWorkspace.Workspace | undefined

    yield* Effect.forkScoped(Effect.forever(Effect.gen(function*() {
      const message = (yield* Queue.take(inbox)) as Protocol.ToWorker
      switch (message._tag) {
        case "Open":
          workspace = TypeScriptWorkspace.make(options.typescript, message.paths, loader, {
            files: options.limits?.files ?? TypeScriptWorkspace.MAX_FILES,
            bytes: options.limits?.bytes ?? TypeScriptWorkspace.MAX_BYTES
          })
          yield* Effect.logDebug("browser.language_server.open").pipe(
            Effect.annotateLogs({ files: message.paths.length })
          )
          return
        case "Files": {
          const answer = reads.get(message.id)
          reads.delete(message.id)
          if (answer !== undefined) yield* Deferred.succeed(answer, message.files)
          return
        }
        case "Cancel": {
          const signal = cancelled.get(message.id)
          if (signal !== undefined) yield* Deferred.succeed(signal, undefined)
          return
        }
        case "Request":
          cancelled.set(message.id, yield* Deferred.make<void>())
          yield* Queue.offer(requests, message)
      }
    })))

    const handle = (message: Protocol.RequestMessage): Effect.Effect<unknown, TypeScriptWorkspace.Refusal> => {
      if (workspace === undefined) {
        return Effect.fail(new TypeScriptWorkspace.Refusal({ code: "invalid_input", message: "No workspace is open" }))
      }
      const { character = 0, line = 0, path = "", query = "", text = "" } = message.params
      const at = { line, character }
      switch (message.method) {
        case "hover":
          return workspace.hover(path, at)
        case "definition":
          return workspace.definition(path, at)
        case "references":
          return workspace.references(path, at)
        case "implementation":
          return workspace.implementation(path, at)
        case "documentSymbols":
          return workspace.documentSymbols(path)
        case "workspaceSymbols":
          return workspace.workspaceSymbols(query)
        case "diagnostics":
          return workspace.diagnostics(path)
        case "sync":
          return workspace.sync(path, text)
        case "close":
          return workspace.close(path)
      }
    }

    return yield* Effect.forever(Effect.gen(function*() {
      const message = yield* Queue.take(requests)
      const signal = cancelled.get(message.id)!
      const exit = yield* Effect.raceFirst(
        Deferred.await(signal).pipe(Effect.as(null)),
        Effect.exit(handle(message))
      ).pipe(Effect.ensuring(Effect.sync(() => cancelled.delete(message.id))))
      if (exit === null) return
      if (exit._tag === "Success") {
        return yield* post({ _tag: "Reply", id: message.id, result: exit.value, ...workspace!.loaded() })
      }
      const reason = exit.cause.reasons[0]
      const refusal = reason?._tag === "Fail" ? reason.error : undefined
      yield* post({
        _tag: "Refuse",
        id: message.id,
        method: message.method,
        code: refusal?.code ?? "request_failed",
        message: refusal?.message ?? "TypeScript failed"
      })
      if (refusal === undefined) {
        yield* Effect.logError("browser.language_server.defect").pipe(Effect.annotateLogs({ method: message.method }))
      }
    }))
  })

/**
 * The worker entry: call it once at the top of the module {@link make}'s
 * `worker` starts. It runs {@link program} on the worker's own messages
 * until the worker ends, on `BrowserScheduler.make()`.
 *
 * @category running
 * @since 1.0.0
 */
export const serve = (options: ServeOptions): Fiber.Fiber<never> =>
  Effect.runFork(
    Effect.scoped(program({ ...options, port: options.port ?? (globalThis as unknown as Protocol.Port) })),
    {
      scheduler: BrowserScheduler.make()
    }
  )
