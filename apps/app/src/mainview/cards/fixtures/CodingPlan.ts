import type { Plan } from "../../../../../../flows/coding/schema.ts"

/** Synthetic recipe input; no native operation or check is claimed to have run. */
export const CODING_PLAN: Plan = {
  prompt: "Connect repository memory to the UI. Preserve  two spaces.\nReview before delivery.",
  memoryRevision: "wiki-revision-42",
  base: {
    changeId: "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
    commitId: "a".repeat(40),
    treeId: "b".repeat(40),
    operationId: "c".repeat(128),
    parentCommitIds: ["d".repeat(40)]
  },
  changes: [
    {
      id: "memory",
      title: "Store repository memory",
      intent: "Keep memory in the existing collection.",
      implementation: "implement-memory",
      implementationDigest: "memory-flow-digest",
      atoms: [{
        changeId: "llllllllllllllllllllllllllllllll",
        message: "✨ feat(memory): persist causal documents",
        intent: "Amend the owning memory change.",
        reads: ["src/memory.ts"],
        writes: ["src/memory.ts", "src/memory.test.ts"]
      }],
      checks: [
        {
          id: "types",
          target: "//memory:typecheck",
          flow: "check-types",
          flowDigest: "types-flow-digest",
          tier: "fast",
          required: true
        },
        {
          id: "review",
          target: "//memory:review",
          flow: "review",
          flowDigest: "review-flow-digest",
          tier: "slow",
          required: true
        }
      ]
    },
    {
      id: "interface",
      title: "Connect the Wiki interface",
      intent: "Expose memory through the shared card.",
      implementation: "implement-ui",
      implementationDigest: "ui-flow-digest",
      atoms: [{
        changeId: null,
        message: "✨ feat(ui): render repository memory",
        intent: "Reuse the existing card.",
        reads: ["src/memory.ts"],
        writes: ["src/Wiki.tsx"]
      }],
      checks: [
        {
          id: "types",
          target: "//ui:typecheck",
          flow: "check-types",
          flowDigest: "types-flow-digest",
          tier: "fast",
          required: true
        },
        {
          id: "browser",
          target: "//ui:browser",
          flow: "browser",
          flowDigest: "browser-flow-digest",
          tier: "slow",
          required: true
        },
        {
          id: "canary",
          target: "//ui:canary",
          flow: "canary",
          flowDigest: "canary-flow-digest",
          tier: "delivery",
          required: false
        }
      ]
    }
  ]
}
