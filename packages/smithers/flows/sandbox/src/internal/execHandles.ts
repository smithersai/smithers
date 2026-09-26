/**
 * Gives Microsandbox's finished streaming exec handles back to the guest.
 *
 * The SDK's streaming exec handle holds its guest agent session until the
 * JavaScript object is garbage collected: draining it, waiting on it, or
 * killing it does not release it. A machine refuses new sessions
 * (`[AgentClient] … handshake: early eof`) once about 140 finished handles
 * are still uncollected, and in a host whose heap is large and quiet that is
 * the machine going dead in the middle of a task. Collecting garbage every
 * {@link collectEvery} starts keeps the uncollected handles well below that.
 *
 * The collector is loaded through `process.getBuiltinModule` on first use:
 * this module is reachable from the browser entry points of `@smthrs/sandbox`
 * and `@smthrs/flows`, and only a Microsandbox host ever collects.
 *
 * @since 0.1.0
 */

/**
 * How many command starts pass between two collections: with the concurrent
 * commands of one session on top, far fewer than the handles a machine
 * refuses at.
 *
 * @category constants
 * @since 0.1.0
 */
export const collectEvery = 64

/**
 * The runtime's full garbage collection: an exposed `gc`, Bun's `Bun.gc`, or
 * Node's collector exposed on first use when the process was not started with
 * `--expose-gc`.
 *
 * @category constructors
 * @since 0.1.0
 */
export const exposeCollector = (runtime: object = globalThis): () => void => {
  const exposed: unknown = Reflect.get(runtime, "gc")
  if (typeof exposed === "function") return exposed as () => void
  // Bun takes no V8 flags; it exposes its collector itself.
  const bun: unknown = Reflect.get(runtime, "Bun")
  const collect: unknown = typeof bun === "object" && bun !== null ? Reflect.get(bun, "gc") : undefined
  if (typeof collect === "function") return () => void collect.call(bun, true)
  process.getBuiltinModule("node:v8").setFlagsFromString("--expose-gc")
  return process.getBuiltinModule("node:vm").runInNewContext("gc") as () => void
}

/**
 * Counts command starts and collects garbage every `every` of them with the
 * collector `expose` yields, looked up once.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeReleaser = (
  expose: () => () => void = exposeCollector,
  every: number = collectEvery
): { readonly started: () => void; readonly release: () => void } => {
  let collector: (() => void) | undefined
  let count = 0
  const release = () => {
    collector ??= expose()
    collector()
  }
  return {
    started: () => {
      if (++count % every === 0) release()
    },
    release
  }
}

/**
 * The process's one releaser: every Microsandbox command start counts.
 *
 * @category constants
 * @since 0.1.0
 */
export const execHandles = makeReleaser()
