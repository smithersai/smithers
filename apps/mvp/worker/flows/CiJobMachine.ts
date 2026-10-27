import { digestSync, Uuid, WebCrypto } from "@smthrs/crypto"
import { Action, Interpreter } from "@smthrs/flow"
import { CiJob, type SandboxTools } from "@smthrs/sandbox"
import { Effect, Layer, Metric } from "effect"
import { Machines } from "../branch/Machines.ts"
import type { SandboxBranch } from "../branch/Sandboxes.ts"

// A CI job's machine (docs/features/ci.md#jobs): `@smthrs/sandbox`'s `ci/job` runs on one throwaway branch machine per
// `job:<run>:<job>`, a `SandboxObject` of `kind: "job"` from the branch sandbox's image (Node, pnpm, Go, Python, git),
// whose box reaches the package registries and nothing else (worker/branch/RegistryEgress.ts). Its checkout is the one commit, fetched
// by its id from GitHub (worker/branch/Checkout.ts), so a fork's pull request head needs no branch. Its commands run as
// the `ci` user, never a person's. Records carry ids and outcomes, never a command or its output.

/** Whom a job's commands run as in its box: a CI job has no person. */
export const CI_OWNER = "ci"

/** The namespace of a job's tool call ids: the version 5 UUID of `<run>:<job>:<call>`. */
export const CI_JOB_NAMESPACE = "6f3c0d1e-5b7a-4c8e-9a2d-1e4f6b8c0a35"

/** The machine job `job` of `target`'s run runs on: one per run and job, named by a digest of the two. */
export const machineOf = (target: CiJob.Target, job: string): SandboxBranch => {
  const [owner = "", name = ""] = target.repo.split("/")
  return {
    branchId: `job-${digestSync(`job:${target.run}:${job}`).slice(0, 40)}`,
    owner,
    name,
    branch: target.sha,
    forge: "github",
    kind: "job",
  }
}

/** A job's tool calls on its machine, by `call` (`checkout`, `step`, `release`) and `outcome`. */
export const calls = Metric.counter("smithers_ci_job_calls", {
  description: "CI jobs' calls on their machines, by call and outcome",
  incremental: true,
})

/**
 * Stops every process the job's user still has, but this command's own shell and its ancestors: a step's server or
 * watcher left in the background would keep the machine awake (worker/branch/Machine.ts `PROBE`). POSIX sh over /proc:
 * the image has no procps.
 */
export const STOP_LEFTOVERS = [
  `keep=" $$ "; p=$$`,
  `while [ "$p" -gt 1 ] 2>/dev/null; do p=$(cut -d' ' -f4 /proc/$p/stat 2>/dev/null); [ -n "$p" ] || break; keep="$keep$p "; done`,
  `me=$(id -u)`,
  `for d in /proc/[0-9]*; do q=\${d#/proc/}; [ "$q" = 1 ] && continue; case "$keep" in *" $q "*) continue ;; esac; [ "$(stat -c %u "$d" 2>/dev/null)" = "$me" ] && kill -KILL "$q" 2>/dev/null; done`,
  `true`,
].join("\n")

/** The exit code a step records when its machine lost it: it started and never reported an end. */
export const LOST_EXIT_CODE = -1

type ToolError = Effect.Error<ReturnType<Machines["Service"]["tool"]>>

/** Whether `error` means the machine couldn't start or answer, which the step retries. */
const unavailable = (error: ToolError): boolean =>
  error._tag === "@smthrs/mvp/branch/SandboxUnavailable" || error._tag === "@smthrs/mvp/branch/SandboxStartTimedOut"

const counted = (call: string, outcome: string, target: CiJob.Target, job: string) =>
  Effect.andThen(
    Metric.update(Metric.withAttributes(calls, { call, outcome }), 1),
    Effect.logInfo("ci.job.call").pipe(Effect.annotateLogs({ run: target.run, repo: target.repo, job, call, outcome })),
  )

/** `CiJob.Machine` over the host's `Machines`. */
export const layer = Layer.effect(
  CiJob.Machine,
  Effect.gen(function* () {
    const machines = yield* Machines
    const tool = (target: CiJob.Target, job: string, name: string, call: SandboxTools.Call) =>
      Effect.flatMap(
        Uuid.v5(CI_JOB_NAMESPACE, `${target.run}:${job}:${name}`).pipe(Effect.provide(WebCrypto.layer), Effect.orDie),
        (callId) => machines.tool(machineOf(target, job), CI_OWNER, callId, call),
      )
    return CiJob.Machine.of({
      // The machine's wake fetched exactly the commit; this reads it back, so a job never runs on another.
      checkout: (target, job) =>
        tool(target, job, "checkout", {
          tool: "run",
          command: `test "$(git rev-parse HEAD)" = ${target.sha}`,
          timeoutSeconds: 60,
        }).pipe(
          Effect.map((ran) => (ran.result as typeof SandboxTools.RunResult.Type).exitCode === 0),
          Effect.catch((error) => unavailable(error) ? Effect.fail(new CiJob.MachineUnavailable()) : Effect.succeed(false)),
          Effect.tap((exact) => counted("checkout", exact ? "exact" : "refused", target, job)),
        ),
      run: (target, job, index, step) =>
        tool(target, job, `step:${index}`, {
          tool: "run",
          command: step.run,
          timeoutSeconds: step.timeoutSeconds ?? CiJob.limits.defaultTimeoutSeconds,
        }).pipe(
          Effect.map((ran) => {
            const result = ran.result as typeof SandboxTools.RunResult.Type
            return { exitCode: result.exitCode, timedOut: result.timedOut,
              ...(result.stdout === "" && result.stderr === "" && !result.truncated ? {} : {
                output: { stdout: result.stdout, stderr: result.stderr, truncated: result.truncated },
              }),
            }
          }),
          // A command the machine lost or refused isn't run again: it runs at most once per call.
          Effect.catch((error) =>
            unavailable(error)
              ? Effect.fail(new CiJob.MachineUnavailable())
              : Effect.succeed({ exitCode: LOST_EXIT_CODE, timedOut: false })
          ),
          Effect.tap((ran) => counted("step", ran.exitCode === 0 && !ran.timedOut ? "passed" : "failed", target, job)),
        ),
      // Done with the job: whatever its steps left running is stopped, and its machine sleeps now rather than idling
      // until its keep-alive gives up. Best effort.
      release: (target, job) =>
        tool(target, job, "release", { tool: "run", command: STOP_LEFTOVERS, timeoutSeconds: 30 }).pipe(
          Effect.flatMap((ran) => machines.sleepIfIdle(machineOf(target, job).branchId, ran.generation, 0)),
          Effect.tap((outcome) => counted("release", outcome, target, job)),
          Effect.ignore,
        ),
    })
  }),
)

/** Registers `ci/job` over the host's `machines`. */
export const registration = <E, R>(machines: Layer.Layer<Machines, E, R>) =>
  Interpreter.layerWithImplementations(CiJob.CiJob, CiJob.layer).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provide(layer),
    Layer.provide(machines),
  )
