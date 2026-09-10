/** Public engineering inputs only. Full files invalidate/are archived even when
 * review uses curated excerpts. Ranges are original inclusive line numbers. */
import type { PageSpec } from "../../flows/wiki/schema.ts"
type Input = string | readonly [string, ...readonly (readonly [number, number])[]]
const page = (spec: Omit<PageSpec, "inputs" | "excerpts">, inputs: readonly Input[]): PageSpec => ({
  ...spec, inputs: inputs.map((input) => typeof input === "string" ? input : input[0]),
  excerpts: Object.fromEntries(inputs.filter((input): input is Exclude<Input, string> => typeof input !== "string").map(([path, ...ranges]) => [path, ranges.map(([start, end]) => ({ start, end }))]))
})
const runtime: Input = ["packages/smithers/flows/src/Runtime.ts", [150, 223]]
const operations: Input = ["flows/wiki/operations.ts", [37, 176]]
const ui = "apps/ui/AGENTS.md"
const flowDocs = "packages/smithers/flows/flow/docs/README.md"
const agentDocs = "packages/smithers/agent/docs/README.md"
const bun = "packages/smithers/flows/src/BunRuntime.ts"
const node = "packages/smithers/flows/src/NodeRuntime.ts"

export const pages: readonly PageSpec[] = [
  page({ id: "start-here", title: "Start here", purpose: "Find the owning layer and follow work through Smithers.", kind: "current", document: "factory/wiki/pages/start-here.md", related: ["flows", "runtime", "build-graph", "product-ui", "coding-request", "coding-direction"] }, [
    flowDocs, runtime, agentDocs, "packages/smithers/build/targets/docs/README.md", ui, bun, node,
    ["packages/smithers/agent/src/AgentAction.ts", [253, 302], [390, 430]],
    ["flows/wiki/operations.ts", [93, 138]], "apps/ui/docs/ONBOARDING.md",
    ["factory/wiki/catalog.ts", [86, 86], [69, 69], [91, 91], [96, 96], [101, 101], [106, 106], [112, 112], [116, 116], [122, 122], [130, 130]]
  ]),
  page({ id: "flows", title: "Flows, actions and replay", purpose: "Declare a typed capability once and attach its Effect implementation.", kind: "current", document: "factory/wiki/pages/flows.md", related: ["runtime", "agent", "build-graph"] }, [
    flowDocs, ["packages/smithers/flows/flow/src/Action/Action.ts", [109, 241]],
    ["packages/smithers/flows/flow/src/Flow/make.ts", [55, 191], [257, 291]],
    "factory/wiki/pages/build-graph.md", "packages/smithers/flows/docs/concepts/runtime-portability.md", "flows/wiki/PACKAGE.ts"
  ]),
  page({ id: "runtime", title: "Runtime portability and ownership", purpose: "Run the same durable program on Bun or Node through injected platform services.", kind: "current", document: "packages/smithers/flows/docs/concepts/runtime-portability.md", related: ["flows", "storage", "wiki-generation"] }, [
    runtime, bun, node, ["packages/smithers/flows/src/internal/NativeRuntime.ts", [63, 126], [342, 451]],
    "packages/smithers/flows/test/NativeRuntimeParity.test.ts", "packages/smithers/flows/test/fixtures/native-runtime.ts",
    "packages/smithers/flows/test/NodeRuntimeStartup.test.ts", "packages/smithers/flows/test/NodeRuntimeSignals.integration.test.ts",
    ["packages/smithers/flows/test/NodeRuntime.test.ts", [783, 835], [1167, 1175], [1518, 1528]],
    ["packages/smithers/flows/test/NodeRuntimeContainment.integration.test.ts", [1, 74], [201, 244]],
    "packages/smithers/flows/database/src/node/NodeDatabase.ts", "packages/smithers/flows/database/src/bun/BunDatabase.ts",
    ["packages/smithers/flows/database/src/internal/SqliteOpen.ts", [65, 123], [132, 208], [291, 343]],
    ["packages/smithers/flows/database/src/DurableWriter.ts", [64, 106], [208, 310]],
    ["packages/smithers/flows/platform-node/src/AtomicFileSystem.ts", [1420, 1475], [1834, 1872], [2026, 2096]],
    "packages/smithers/flows/platform-node/test/AtomicFileSystemRuntimeParity.test.ts", "packages/smithers/flows/platform-node/test/fixtures/atomic-helper-identity.ts"
  ]),
  page({ id: "storage", title: "Journal and durable stores", purpose: "Use existing persisted execution facts instead of another coding ledger.", kind: "current", document: "factory/wiki/pages/storage.md", related: ["runtime", "flows", "wiki-generation"] }, [
    runtime, bun, node, "packages/smithers/flows/journal/docs/README.md", "packages/smithers/flows/run-store/docs/README.md",
    ["packages/smithers/flows/database/src/DurableWriter.ts", [64, 106], [208, 310]],
    ["packages/smithers/flows/flow/src/Action/Action.ts", [109, 241]], ["flows/wiki/operations.ts", [93, 144]]
  ]),
  page({ id: "build-graph", title: "Dependency-bound build targets", purpose: "Declare the exact code and documentation inputs that invalidate an output.", kind: "current", document: "factory/wiki/pages/build-graph.md", related: ["wiki-generation", "flows", "runtime"] }, [
    "packages/smithers/build/targets/docs/reference/filegroup.md", ["packages/smithers/build/targets/src/Filegroup.ts", [25, 91], [185, 283]],
    ["packages/smithers/build/targets/src/Shell.ts", [25, 115], [265, 350]], ".smithers/WORKSPACE.ts", "flows/wiki/PACKAGE.ts",
    ["factory/wiki/catalog.ts", [1, 15], [134, 134]], "flows/wiki/workflow.ts", operations, "flows/wiki/main.ts",
    "flows/coding/testing.md", "packages/smithers/build/build-cli/src/internal/InputPackage.ts", "flows/PACKAGE.ts", "flows/test/coding-native-gate.mjs",
    ["packages/smithers/build/build-cli/src/internal/PackagePlanner.ts", [1334, 1343]],
    ["packages/smithers/build/build-cli/src/TargetIndex.ts", [150, 164]],
    ["packages/smithers/build/build-cli/src/Affected.ts", [155, 170], [200, 212]]
  ]),
  page({ id: "agent", title: "Agents are flow callers", purpose: "Understand cells, schema-bound model output and host-owned model seats.", kind: "current", document: "factory/wiki/pages/agent.md", related: ["flows", "wiki-generation", "product-ui"] }, [
    agentDocs, ["packages/smithers/agent/src/AgentAction.ts", [94, 149], [253, 302], [390, 430], [644, 774]],
    "flows/wiki/workflow.ts", "flows/wiki/runtime.ts", "flows/wiki/evidence.ts", operations, "apps/ui/docs/workbench-lanes/runs.md"
  ]),
  page({ id: "product-ui", title: "Embedded UI and recursive inspection", purpose: "Follow the existing frame, card and dispatcher boundaries.", kind: "current", document: "factory/wiki/pages/product-ui.md", related: ["agent", "storage", "coding-direction", "cloud-wiki"] }, [
    ui, ["apps/ui/docs/ONBOARDING.md", [1, 20], [82, 96]], ["apps/ui/src/mainview/cards/RunTrace.ts", [21, 108], [154, 177], [521, 595]],
    ["apps/ui/src/mainview/cards/RunTraceCard.tsx", [1, 19], [69, 98], [101, 140], [197, 242], [250, 285], [329, 345]],
    "apps/ui/src/mainview/runtime/FrameHistory.ts", "apps/ui/docs/workbench-lanes/runs.md",
    "apps/ui/docs/workbench-lanes/coding-plans.md", "apps/ui/docs/workbench-lanes/native-engine-evidence.md",
    ["flows/wiki/operations.ts", [93, 144]]
  ]),
  page({ id: "wiki-generation", title: "How this wiki stays accountable", purpose: "Separate source freshness, semantic review and human intent.", kind: "current", document: "factory/wiki/pages/wiki-generation.md", related: ["build-graph", "runtime", "coding-direction"] }, [
    "flows/wiki/schema.ts", "flows/wiki/workflow.ts", "flows/wiki/evidence.ts", "flows/wiki/operations.ts", "flows/wiki/runtime.ts", "flows/wiki/PACKAGE.ts", ["factory/wiki/catalog.ts", [1, 15], [134, 134]], "flows/wiki/reuse.ts", "flows/coding/request.ts", "flows/coding/wiki-check.ts", "flows/coding/immutable-source.ts", ["flows/coding/planning.ts", [123, 143]], "factory/coding/project.ts"
  ]),
  page({ id: "coding-direction", title: "Mythical coding product contract", purpose: "Read the intended lifecycle without confusing it with shipped behavior.", kind: "intent", document: "factory/wiki/pages/coding-direction.md", related: ["product-ui", "wiki-generation", "runtime", "coding-request", "coding-experience"] }, [
    "packages/smithers/flows/docs/concepts/runtime-portability.md", ui
  ]),
  page({ id: "coding-progression", title: "Coding progression and validation", purpose: "Follow exact JJ revisions through fast gates and overlapping slow checks.", kind: "current", document: "factory/wiki/pages/coding-progression.md", related: ["coding-direction", "flows", "coding-request", "coding-correction", "coding-checks"] }, [
    "flows/coding/schema.ts", "flows/coding/workflow.ts", "flows/coding/catalog.ts", "flows/coding/registration.ts", "flows/coding/flow.ts", "flows/test/coding.test.ts", "packages/smithers/flows/core/src/Digest.ts", "flows/coding/request.ts", "flows/coding/correction.ts"
  ]),
  page({ id: "cloud-wiki", title: "Collaborative repository Wiki", purpose: "Separate local history, remote revisions, pending edits and semantic truth.", kind: "current", document: "factory/wiki/pages/cloud-wiki.md", related: ["wiki-generation", "product-ui", "storage", "coding-direction"] }, [
    "apps/ui/docs/workbench-lanes/wiki-collaboration.md", "apps/ui/src/mainview/wiki/CloudWiki.ts", "apps/ui/src/mainview/wiki/CloudWikiState.ts",
    ["apps/ui/src/mainview/state/controller/cloud-wiki.ts", [28, 130], [132, 274], [432, 486]],
    ["apps/ui/src/mainview/cards/ConversationCards.tsx", [88, 183]],
    ["apps/ui/src/mainview/flows/entries/wiki.ts", [36, 84]], "apps/ui/docs/ONBOARDING.md",
    "apps/ui/src/mainview/wiki/CloudWiki.test.ts", "apps/ui/src/mainview/wiki/fixtures/yrs-deletion-ack.json"
  ]),
  page({ id: "native-control", title: "Portable native control and authority", purpose: "Locate the one injected host, approved-root authority and native observation boundary.", kind: "current", document: "factory/wiki/pages/native-control.md", related: ["runtime", "storage", "coding-host", "native-engine-evidence"] }, [
    "packages/smithers/src/internal/NativeControl.ts", "packages/smithers/src/internal/NodeControlHost.ts", "packages/smithers/src/internal/BunControl.ts",
    "packages/smithers/src/internal/ModuleAuthority.ts", "packages/smithers/src/internal/ModuleAdmission.ts", "packages/smithers/src/internal/EngineJournalSupervisor.ts"
  ]),
  page({ id: "coding-host", title: "Configured coding host", purpose: "Compose the native host and operator policy without a new product service.", kind: "current", document: "factory/wiki/pages/coding-host.md", related: ["native-control", "coding-request", "coding-checks", "runtime"] }, [
    "flows/coding/host.ts", "flows/coding/host.md", "flows/coding/serve.ts", "flows/coding/project-config.ts", "flows/coding/project-config.md",
    "flows/coding/build.mjs", "flows/coding/planning-authority.ts", "flows/coding/wiki-policy.ts", "flows/coding/wiki-output.ts", "flows/coding/wiki-registry.ts", "factory/coding/project.ts", "flows/checks/wiki/flow.ts", "packages/smithers/NATIVE-CONTROL.md",
    "flows/test/coding-host.test.ts", "flows/test/coding-host-bundle.mjs", ["flows/coding/planning-wiki.ts", [111, 138]], ["flows/wiki/operations.ts", [129, 140]]
  ]),
  page({ id: "coding-request", title: "Prompt to coding outcome", purpose: "Follow verified wiki, planning, saved prototype and owner correction through ordinary native children.", kind: "current", document: "factory/wiki/pages/coding-request.md", related: ["coding-planning", "coding-poc", "coding-correction", "coding-host", "coding-ui"] }, [
    "flows/coding/request.ts", "flows/coding/request.md", "flows/coding/request/flow.ts", "flows/coding/schema.ts",
    "flows/coding/source-admission.ts", ["flows/coding/host.ts", [84, 148]], "flows/coding/planning-wiki.md", "flows/coding/poc.md",
    ["flows/test/coding-request-host.test.ts", [22, 40], [77, 81], [128, 135], [147, 173], [175, 225]], "flows/coding/steering.ts", ["flows/coding/correction.ts", [153, 174], [206, 228]], "apps/ui/src/mainview/cards/CodingPlan.ts"
  ]),
  page({ id: "coding-planning", title: "Planning from repository memory", purpose: "Gather verified memory, ask material questions and bind the Plan to native source and catalog definitions.", kind: "current", document: "factory/wiki/pages/coding-planning.md", related: ["wiki-generation", "coding-request", "coding-progression", "coding-poc"] }, [
    "flows/coding/planning.ts", "flows/coding/planning-memory.ts", "flows/coding/planning-wiki.ts",
    "flows/coding/planning-authority.ts", "flows/coding/source-admission.ts", "flows/coding/schema.ts",
    ["flows/coding/host.ts", [66, 115]], ["flows/coding/request.ts", [30, 76]], ["flows/coding/poc.ts", [1, 50]], "flows/coding/planning-wiki.md", "flows/wiki/reuse.ts"
  ]),
  page({ id: "coding-poc", title: "Saved disposable source prototypes", purpose: "Retain measured source changes for hindsight without claiming an executable prototype or mutating the original.", kind: "current", document: "flows/coding/poc.md", related: ["coding-request", "coding-planning", "coding-ui"] }, [
    "flows/coding/poc.ts", "flows/coding/poc-source.ts", "flows/coding/poc-schema.ts", "flows/coding/planning-authority.ts",
    "flows/coding/request.ts", "flows/coding/source-admission.ts", "flows/test/coding-poc.test.ts", ["flows/coding/host.ts", [84, 148]], "flows/coding/steering.ts", "apps/ui/src/mainview/cards/CodingPoc.ts",
    "apps/ui/src/mainview/cards/CodingPocCard.tsx", ["apps/ui/src/mainview/cards/EngineTrace.ts", [64, 75], [335, 371]], ["packages/smithers/flows/flow/docs/README.md", [1, 25], [94, 118]]
  ]),
  page({ id: "coding-correction", title: "Bounded owner correction", purpose: "Repair the earliest owning atom and remeasure rewritten descendants while preserving exact native evidence.", kind: "current", document: "factory/wiki/pages/coding-correction.md", related: ["coding-progression", "coding-checks", "coding-request", "coding-ui"] }, [
    "flows/coding/correction.ts", "flows/coding/feedback.ts", "flows/coding/feedback-schema.ts",
    "flows/coding/workflow.ts", "flows/coding/schema.ts", "flows/coding/planning-authority.ts", ["flows/coding/host.ts", [84, 148]],
    ["flows/test/coding-correction.test.ts", [40, 45], [95, 107], [126, 177], [185, 214]], ["flows/coding/native.ts", [63, 72], [92, 109], [140, 162]], ["flows/coding/atoms.ts", [47, 95], [98, 115]], ["flows/coding/request.ts", [30, 76]],
    ["packages/smithers/flows/flow/src/DurableDeferred.ts", [125, 162], [581, 611]]
  ]),
  page({ id: "coding-checks", title: "Checks against immutable source", purpose: "Measure the pinned revision with declared commands, confined processes and durable receipts.", kind: "current", document: "flows/coding/checks.md", related: ["coding-progression", "coding-correction", "coding-host", "build-graph"] }, [
    "flows/coding/checks.ts", "flows/coding/immutable-source.ts", "flows/coding/wiki-check.ts", "flows/coding/wiki-check.md", "flows/coding/catalog.ts", "flows/coding/schema.ts", "flows/coding/host.ts", "flows/test/coding-checks.test.ts", ["packages/smithers/agent/registry/src/Executable.ts", [117, 159], [785, 834]],
    ["packages/smithers/agent/registry/src/MarkdownFlow.ts", [160, 205]], ["packages/smithers/flows/flow/src/Action/make.ts", [142, 184], [203, 241]]
  ]),
  page({ id: "coding-ui", title: "Coding evidence in recursive run cards", purpose: "Keep predicted work, retained prototypes, native outcomes and historical source selection distinct.", kind: "current", document: "factory/wiki/pages/coding-ui.md", related: ["product-ui", "native-engine-evidence", "coding-request", "coding-experience"] }, [
    "apps/ui/docs/workbench-lanes/coding-plans.md", "apps/ui/docs/workbench-lanes/native-engine-evidence.md",
    "apps/ui/src/mainview/cards/CodingPlan.ts", "apps/ui/src/mainview/cards/CodingPlanCard.tsx", ["apps/ui/src/mainview/cards/EngineTrace.ts", [1, 75], [108, 180], [232, 268], [299, 371]],
    "apps/ui/src/mainview/cards/CodingPocCard.tsx", "apps/ui/src/mainview/state/RunReference.ts", "flows/coding/schema.ts", "flows/coding/poc-schema.ts", "apps/ui/src/mainview/cards/CodingPoc.ts",
    "apps/ui/src/mainview/cards/CodingPoc.test.ts", ["apps/ui/src/mainview/cards/CodingPlan.test.ts", [1, 80], [100, 196]]
  ]),
  page({ id: "native-engine-evidence", title: "Native execution evidence and observation", purpose: "Read native attempts and terminal results without confusing reader completion with product validation.", kind: "current", document: "apps/ui/docs/workbench-lanes/native-engine-evidence.md", related: ["native-control", "coding-ui", "storage", "product-ui"] }, [
    "apps/ui/src/mainview/cards/EngineTrace.ts", "packages/smithers/src/internal/EngineJournalProjection.ts",
    "packages/smithers/src/internal/EngineJournalSupervisor.ts",
    ["apps/ui/src/mainview/state/controller/workflow-pump.ts", [55, 66], [155, 242], [284, 380], [427, 475]]
    , ["apps/ui/src/mainview/cards/RunTraceCard.tsx", [197, 235], [250, 272]],
    ["apps/ui/src/mainview/state/controller/runs.ts", [412, 445]], ["apps/ui/src/mainview/flows/entries/runs.ts", [185, 202]],
    ["apps/ui/package.json", [30, 40]], ["apps/ui/AGENTS.md", [27, 42]], ["apps/ui/docs/ONBOARDING.md", [82, 96]]
  ]),
  page({ id: "coding-experience", title: "Stack and debugger interaction study", purpose: "Apply concrete prior-art interactions while labeling recommendations separately from current UI behavior.", kind: "intent", document: "factory/wiki/pages/coding-experience.md", related: ["coding-direction", "coding-ui", "product-ui", "native-engine-evidence"] }, [
    "apps/ui/docs/workbench-lanes/coding-plans.md", "apps/ui/docs/workbench-lanes/native-engine-evidence.md", "factory/wiki/pages/coding-direction.md"
  ])
]
export const sourceFiles = [...new Set(pages.flatMap((page) => [page.document, ...page.inputs]))].sort()
