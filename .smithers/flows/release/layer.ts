/**
 * The release flow's action implementations, for the host that loads
 * `release/flow.ts`.
 *
 * The layer holds implementations only: the host supplies the engine, the
 * agent, the seats, the budget and the approval store.
 */
import { Layer } from "effect"
import { repositoryRoot } from "../automation/run-module.ts"
import { actionLayers } from "../release-support/operations.ts"
import { AuditDocs } from "./workflow.vibe"

/** The implementations against one checkout; tests pass a scratch repository and a recording command runner. */
export const layerAt = (options: Parameters<typeof actionLayers>[0]) =>
  Layer.merge(actionLayers(options), AuditDocs.layer)

/** The implementations against the checkout this file is in. */
export const layer = layerAt({ root: repositoryRoot(new URL(import.meta.url)) })
