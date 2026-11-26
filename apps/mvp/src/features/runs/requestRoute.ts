import type { Effect } from "effect"
import { flowInputsRoute, repoFlowsRoute, repoRunsRoute } from "../actions/contract"

type Request<A, E, R> = (path: string) => Effect.Effect<A, E, R>

// Keep URI encoding at request construction, where the repository client has always done it.
export const requestRepoFlows = <A, E, R>(
  owner: string, name: string, request: Request<A, E, R>,
): Effect.Effect<A, E, R> => request(repoFlowsRoute(owner, name))

export const requestFlowInputs = <A, E, R>(
  owner: string, name: string, flow: string, request: Request<A, E, R>,
): Effect.Effect<A, E, R> => request(flowInputsRoute(owner, name, flow))

export const requestRepoRuns = <A, E, R>(
  owner: string, name: string, request: Request<A, E, R>,
): Effect.Effect<A, E, R> => request(repoRunsRoute(owner, name))
