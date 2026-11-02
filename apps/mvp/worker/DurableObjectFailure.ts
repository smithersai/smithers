// What a failed Durable Object call says, recorded without its content. Cloudflare marks the errors its runtime raises
// with `retryable`, `overloaded` and `remote` (Durable Objects: Error handling), and their messages name a fixed set of
// platform causes; a message can also carry a URL, an address or a person's data, so only its category is recorded,
// and an error's class only when it is one of `KNOWN_CLASSES`. Every reader here is total: a thrown value can be
// anything, `Object.create(null)` or a proxy whose getters throw, and describing it must never replace it.
// Electric's gateway records its failed calls into the object with it (infra/ElectricRelay.ts).

/** What a failure said, by category: Cloudflare's own failures by name, never the message text. */
export type Category =
  | "connection-lost"
  | "reset"
  | "instance-inactive"
  | "overloaded"
  | "memory-limit"
  | "cpu-limit"
  | "storage-timeout"
  | "internal"
  | "other"

// Cloudflare's Durable Object error messages (Durable Objects: Error handling, Known limitations), first match wins.
const categories: ReadonlyArray<readonly [RegExp, Category]> = [
  [/network connection lost/i, "connection-lost"],
  [/instance is no longer active/i, "instance-inactive"],
  [/is overloaded/i, "overloaded"],
  [/exceeded its memory limit/i, "memory-limit"],
  [/exceeded its CPU/i, "cpu-limit"],
  [/storage operation exceeded timeout/i, "storage-timeout"],
  [/reset because its code was updated/i, "reset"],
  [/internal error/i, "internal"],
]

/** `read()`, or `fallback` when reading throws. */
const safely = <A>(read: () => A, fallback: A): A => {
  try {
    return read()
  } catch {
    return fallback
  }
}

/** The `Category` of an error, from its message, which is never recorded itself. Never throws. */
export const categoryOf = (error: unknown): Category =>
  safely(() => {
    if (typeof error !== "object" || error === null) return "other"
    const message = (error as { readonly message?: unknown }).message
    if (typeof message !== "string") return "other"
    return categories.find(([pattern]) => pattern.test(message))?.[1] ?? "other"
  }, "other")

/** Whether Cloudflare set `name` on an error: only a literal `true` counts. Never throws. */
export const flag = (error: unknown, name: "retryable" | "overloaded" | "remote"): boolean =>
  safely(
    () => typeof error === "object" && error !== null && (error as { readonly [key: string]: unknown })[name] === true,
    false,
  )

/**
 * The error classes and tags a record may name. Anything else, a tag built from content included, is `unknown`, so a
 * class label never carries content and a metric's `errorClass` stays bounded.
 */
export const KNOWN_CLASSES: ReadonlySet<string> = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "DOMException",
  "AbortError",
  "TimeoutError",
  // alchemy's Durable Object RPC stub and binding adapter.
  "RpcCallError",
  "HandlerNotReady",
  // Cloudflare's container port failures (infra/ElectricAwake.ts).
  "ContainerCrashedError",
  "ContainerNotRunningError",
  // Effect's HTTP and SQL failures.
  "HttpClientError",
  "HttpServerError",
  "SqlError",
  "UnknownError",
])

/** An error's `_tag`, else its class name, when `KNOWN_CLASSES` has it; `unknown` otherwise. Never throws. */
export const classOf = (error: unknown): string =>
  safely(() => {
    if (typeof error !== "object" || error === null) return "unknown"
    const tag = (error as { readonly _tag?: unknown })._tag
    const name = typeof tag === "string"
      ? tag
      : (error as { readonly constructor?: { readonly name?: unknown } | undefined }).constructor?.name
    return typeof name === "string" && KNOWN_CLASSES.has(name) ? name : "unknown"
  }, "unknown")

/** What is recorded of a failure: its class, Cloudflare's three flags and its message's category. Never throws. */
export const describe = (error: unknown) => ({
  errorTag: classOf(error),
  category: categoryOf(error),
  retryable: flag(error, "retryable"),
  overloaded: flag(error, "overloaded"),
  remote: flag(error, "remote"),
})
