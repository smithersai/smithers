import { describe, expect, it } from "vitest"
import { extractPostMergeFlowIds, planPostMergeFlows, postMergeRunId } from "./PostMerge.vibe"

describe("PostMerge automation planner", () => {
  const sampleFactory = {
    on: {
      "change.landed": {
        flow: ["release", "docs-publish", "wiki-refresh", "mythical-fold", "backpressure-audit"],
        description: "Publish release, docs, wiki, mythical history, and backpressure audit on merge",
      },
      "github.push:main": {
        flow: ["wiki-refresh", "docs-publish", "../escape"],
      },
    },
  }

  it("extracts, validates, deduplicates, and deterministically orders post-merge flows", () => {
    const flows = extractPostMergeFlowIds(sampleFactory, "main")
    expect(flows).toEqual([
      "backpressure-audit",
      "wiki-refresh",
      "mythical-fold",
      "docs-publish",
      "release",
    ])
  })

  it("plans trusted repo/Run requests only for the default branch with idempotent run ids", () => {
    const sha = "a".repeat(40)
    const planned = planPostMergeFlows({
      repo: "smithersai/smithers",
      defaultBranch: "main",
      targetBranch: "main",
      mergeSha: sha,
      factoryJson: sampleFactory,
    })
    expect(planned.length).toBe(5)
    expect(planned[0]!.flow).toBe("backpressure-audit")
    expect(planned[0]!.runId).toBe(postMergeRunId("backpressure-audit", sha))
    expect(planned[0]!.request.secrets).toBe(true)
    expect(planned[0]!.request.event).toBe("push")
    expect(planned[0]!.request.ref).toBe("refs/heads/main")
    expect(planned[4]!.flow).toBe("release")
  })

  it("ignores non-default branches and invalid commit SHAs", () => {
    expect(planPostMergeFlows({
      repo: "smithersai/smithers",
      defaultBranch: "main",
      targetBranch: "feature/foo",
      mergeSha: "b".repeat(40),
      factoryJson: sampleFactory,
    })).toEqual([])

    expect(planPostMergeFlows({
      repo: "smithersai/smithers",
      defaultBranch: "main",
      targetBranch: "main",
      mergeSha: "not-a-sha",
      factoryJson: sampleFactory,
    })).toEqual([])
  })

  it("supports array-form factory.json `on` declarations as projected by FACTORY.ts", () => {
    const projected = {
      on: [
        { event: "change.landed", flow: ["release", "docs-publish"] },
        { event: "github.push:main", flow: "wiki-refresh" },
      ],
    }
    expect(extractPostMergeFlowIds(projected, "main")).toEqual([
      "wiki-refresh",
      "docs-publish",
      "release",
    ])
  })
})
