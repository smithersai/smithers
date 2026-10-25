import branchManifest from "../../plugins/branches/plugin.json" with { type: "json" }
import createSource from "../../plugins/branches/src/create.source.json" with { type: "json" }
import publishSource from "../../plugins/branches/src/publish.source.json" with { type: "json" }
import updateSource from "../../plugins/branches/src/update.source.json" with { type: "json" }

/** Server-safe flow registry: authored modules are packaged as source, without importing browser UI. */
export const CREATION = { manifest: branchManifest, source: createSource, tag: "branches/create" } as const

/**
 * The first-party `branches` plugin's flow for each branch operation (docs/features/branch-publish.md): what a repository
 * runs unless its `.smithers/branch.json` selects its own.
 */
export const BRANCH_FLOWS = {
  create: CREATION,
  publish: { manifest: branchManifest, source: publishSource, tag: "branches/publish" },
  update: { manifest: branchManifest, source: updateSource, tag: "branches/update" },
} as const
