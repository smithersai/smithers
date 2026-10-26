import { FlowRuntime } from "@smthrs/flow"
import type { EngineStore } from "@smthrs/flows"
import { Effect, Option } from "effect"
import { codeOf } from "../errorCode"
import { entryOf, names } from "./registry"

// What the person already refused in one answer (the agent evals' `flow-delete-denied`, 2026-10-22: denied, the agent
// asked again in other words). Each approval is an `app/agent/ask` child of the answer's run, the agent's own or the
// one a `confirm` flow's call waits on (src/flows/catalog.ts), so the engine's record of those children is the answer's
// own durable record of every no, read again on each call rather than kept in memory.

/** The person's refusals in one answer: whether they denied any approval, and the `confirm` flows they denied. */
export interface Denied {
  readonly any: boolean
  readonly flows: ReadonlySet<string>
}

/** No refusals: what a run that can't be read, or a call outside any run, has. */
const NONE: Denied = { any: false, flows: new Set() }

/** The `confirm` flow each approval prompt belongs to: the registry's prompts, one flow each. */
const confirmed: ReadonlyMap<string, string> = new Map(
  names.flatMap((name) => {
    const { confirm } = entryOf(name)
    return confirm === undefined ? [] : [[confirm, name] as const]
  }),
)

const parsed = (value: { readonly text: string } | null): unknown => {
  if (value === null) return undefined
  try {
    return JSON.parse(value.text)
    // expected: stored input that is not JSON reads as none
  } catch {
    return undefined
  }
}

/**
 * The approvals the person denied among run `session`'s children, as `inspection` records them, leaving out the runs
 * in `own`: a call's own ask is never an earlier refusal of itself, so when its parked run resumes it reads what the
 * person answered, a note included, instead of a bare no. A run it can't read has no refusals: the person is asked, as
 * they would be without this.
 */
export const denied = (
  inspection: EngineStore.RunInspection.RunInspection["Service"],
  session: string,
  own: ReadonlyArray<string> = [],
): Effect.Effect<Denied> =>
  inspection.inspect(session).pipe(
    Effect.map(({ children }) => {
      const flows = new Set<string>()
      let any = false
      for (const child of children) {
        if (child.flowName !== "app/agent/ask" || own.includes(child.runId)) continue
        const input = parsed(child.input) as { readonly kind?: unknown; readonly prompt?: unknown } | undefined
        const result = parsed(child.result) as { readonly approved?: unknown } | undefined
        if (input?.kind !== "approval" || result?.approved !== false) continue
        any = true
        const flow = typeof input.prompt === "string" && child.runId.endsWith("/confirm")
          ? confirmed.get(input.prompt)
          : undefined
        if (flow !== undefined) flows.add(flow)
      }
      return { any, flows }
    }),
    // A run it can't read has no refusals, so the person is asked again; the read's failure is logged by its code.
    Effect.catch((failure) =>
      Effect.logWarning("flow.approvals.read").pipe(
        Effect.annotateLogs({ feature: "flows", outcome: "unreadable", errorCode: codeOf(failure) }),
        Effect.as(NONE),
      )
    ),
  )

/**
 * The refusals of the run the current call belongs to (`FlowRuntime.FlowInstance`), but for the call's `own` runs;
 * outside a run, none.
 */
export const deniedHere = (
  inspection: EngineStore.RunInspection.RunInspection["Service"],
  own: ReadonlyArray<string> = [],
): Effect.Effect<Denied> =>
  Effect.flatMap(Effect.serviceOption(FlowRuntime.FlowInstance), (instance) =>
    Option.isNone(instance) ? Effect.succeed(NONE) : denied(inspection, instance.value.executionId, own))

/** Whether a call of `flow` with `input` is the agent asking the person's approval itself (`app/agent/ask`). */
export const asksApproval = (flow: string, input: unknown): boolean =>
  flow === "app/agent/ask" && typeof input === "object" && input !== null &&
  (input as { readonly kind?: unknown }).kind === "approval"
