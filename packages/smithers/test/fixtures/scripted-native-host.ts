/**
 * An explicit offline judge for process fixtures that boot the native host.
 * Load with Node's --import before the real CLI entry. The CLI still runs its
 * actual bootstrap, storage and control paths; its platform deliberately
 * supplies the same evidence-based completion script as the in-process tests.
 */
import { isMainThread } from "node:worker_threads"

// NODE_OPTIONS also reaches compiler workers and the native compiler's Node
// launcher. They keep their own bootstrap; the offline host belongs to callers.
const compiler = process.argv[1]?.replaceAll("\\", "/").endsWith("/vibelang/bin/vibelang") === true
if (isMainThread && !compiler) {
  const { installEffectResolution } = await import("@smthrs/build-cli/effect-resolution")

  // Detached fixtures carry their preloads through NODE_OPTIONS. Preserve the
  // caller's existing --no-warnings selection there too, before loading tsx.
  if (process.execArgv.includes("--no-warnings") && !process.env.NODE_OPTIONS?.includes("--no-warnings")) {
    process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --no-warnings`.trim()
  }

  installEffectResolution()
  const [ScriptedJudge, { platform }] = await Promise.all([
    import("@smthrs/agent/ScriptedJudge"),
    import("../../src/internal/NodeControlHost.ts")
  ])
  Object.assign(platform, { evaluator: ScriptedJudge.layer })

  // Detached CLI children compose their own host in a fresh process. Carry this
  // explicit fixture decision through the same standard Node preload mechanism.
  const preload = `--import=${import.meta.url}`
  if (!process.env.NODE_OPTIONS?.includes(preload)) {
    process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} ${preload}`.trim()
  }

  // One process fixture opts in to payload-free lifecycle receipts. Observe the
  // existing startup clock after Effect resolution, without changing its timing.
  if (
    process.env.SMITHERS_TEST_CLI_EXIT_DIR !== undefined &&
    !Reflect.get(globalThis, Symbol.for("smithers/test/cli-phase-observer"))
  ) {
    Reflect.set(globalThis, Symbol.for("smithers/test/cli-phase-observer"), true)
    const [{ Effect, Tracer }, { startUp }, { recordStage }] = await Promise.all([
      import("effect"),
      import("../../src/internal/Telemetry.ts"),
      import("./cli-exit-observer.ts")
    ])
    const nativeSpan = Tracer.nativeTracer.span.bind(Tracer.nativeTracer)
    Object.assign(Tracer.nativeTracer, {
      span(options: Parameters<typeof nativeSpan>[0]) {
        const span = nativeSpan(options)
        // Only fixed SDK operation names; never attributes, arguments or errors.
        if (
          /^(SqlControlRuntime|Registry|AgentSession|Control|RunStore|DurableWriter|ExecutionSnapshot)\.[A-Za-z]+$/
            .test(
              options.name
            )
        ) {
          recordStage(`${options.name}.entered`, span.spanId)
          const end = span.end.bind(span)
          span.end = (time, exit) => {
            recordStage(`${options.name}.${exit._tag}`, span.spanId)
            end(time, exit)
          }
        }
        return span
      }
    })
    const mark = startUp.mark
    const ended = startUp.ended
    Object.assign(startUp, {
      mark: (stage: Parameters<typeof mark>[0]) =>
        mark(stage).pipe(Effect.tap(() => Effect.sync(() => recordStage(stage)))),
      ended: (...args: Parameters<typeof ended>) =>
        Effect.gen(function*() {
          recordStage("close.entered")
          yield* ended(...args)
          recordStage("close.finished")
        })
    })
    recordStage("fixture ready")
  }
}
