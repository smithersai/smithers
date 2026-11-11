/**
 * The release-content flow's action implementations, for the host that loads
 * `release-content/flow.ts`.
 *
 * The layer holds implementations only: the host supplies the engine, the
 * agent, the seats, the budget and the approval store.
 */
import { Layer } from "effect"
import { repositoryRoot } from "../automation/run-module.ts"
import { actionLayers } from "../release-support/operations.ts"
import * as Content from "./workflow.ts"

/** The implementations against one checkout; tests pass a scratch repository and a recording command runner. */
export const layerAt = (options: Parameters<typeof actionLayers>[0]) =>
  Layer.mergeAll(
    actionLayers(options),
    Content.Analyze.layer,
    Content.OutlineTemplate.layer,
    Content.DraftChangelog.layer,
    Content.DraftThread.layer,
    Content.OutlineBlog.layer,
    Content.DraftBlog.layer,
    Content.Score.layer,
    Content.Revise.layer
  )

/** The implementations against the checkout this file is in. */
export const layer = layerAt({ root: repositoryRoot(new URL(import.meta.url)) })
