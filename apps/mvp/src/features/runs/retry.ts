import { entryOf, type FlowName, names } from "../../flows/registry"

// Which runs Retry runs again (decision 0014 §2, docs/features/runs.md#acts): a run of a flow the agent may run, its
// own payload again. A flow only a person or the app starts is never retried with its own payload: an answer is retried
// by asking again (decision 0002), a draft's answers by answering again, a person's flow's pinned child through its
// `flow/run`. An act on a run (`run/*`) is not work.

/**
 * Whether a run of `flow` may be retried.
 *
 * @throws {never}
 */
export const retryable = (flow: string): boolean =>
  !flow.startsWith("run/") &&
  (names as ReadonlyArray<string>).includes(flow) &&
  entryOf(flow as FlowName).userOnlyReason === undefined

