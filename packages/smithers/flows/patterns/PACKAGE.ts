import { BuildAndCheckTypeScriptPackage, ReviewDocsAgainstCode, ReviewJsdocAgainstCode } from "@smthrs/repo-targets"
/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"
import * as Input from "@smthrs/targets/Input"

const cwd = "packages/smithers/flows/patterns"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  // examples/ is type-checked, linted and formatted with the sources, and run
  // by test/examples.test.ts.
  sources: Input.glob("{src,examples}/**/*.{ts,vibe}"),
  cwd
})

/**
 * Changed public exports against README.md, docs/*.md, and the site's
 * patterns API reference page.
 *
 * The site page is named as a FILE, not left to the macro's default glob: this
 * is the only package whose reference page exists, so that glob matches nothing
 * here and everything in `apps/site`, which `//:targetIndex` refuses as
 * `declared_input_crosses_package`. `packages/smithers/flows/engine` names its
 * own page the same way.
 */
const reviewDocsAgainstCode = ReviewDocsAgainstCode({
  cwd,
  context: [
    Smithers.file("README.md"),
    Smithers.glob("docs/*.md"),
    Smithers.file("//apps/site/src/content/docs/docs/reference/api/patterns.mdx")
  ]
})

/** Changed public exports against their own JSDoc. */
const reviewJsdocAgainstCode = ReviewJsdocAgainstCode({ cwd })

// Pure orchestration combinators over @smthrs/flow. Member flows are often
// model agents, so every decision value (approval, review verdict, plan, task
// list, item id) is untrusted model output; the checks below say so per threat.
const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**"],
  checks: [
    {
      id: "approval-fails-closed",
      title: "A gated step runs only after a decision that decodes as the literal \"approved\"",
      threat:
        "A model or approver output that is a denial, malformed, or missing lets a write, deploy, or critical runbook step run without human consent.",
      lookFor: [
        "A path in Intervene or Runbook where apply or a gated step is reached before or without decoding the approval output as Pattern.Approved.",
        "Runbook.run with onDeny \"skip\" or \"fail\" treating a thrown or undefined approval result as approval, or a risky/critical step called without an approval call.",
        "Intervene with dryRun true still calling apply, or make and run disagreeing on whether apply is reachable."
      ],
      paths: ["src/Intervene.ts", "src/Runbook.ts", "src/Pattern.ts"]
    },
    {
      id: "accepted-decision-strict",
      title: "Review and escalation verdicts accept only the exact approved shapes",
      threat:
        "A reviewer model returning prose, a truthy non-boolean, or an inherited property settles a review, delegation, or escalation that should have been rejected.",
      lookFor: [
        "Compose.accepted accepting anything beyond true, \"approved\", or an own approved/accepted property strictly equal to true.",
        "Escalation.defaultEscalate settling a result that reports failure through error, failed: true, or ok: false.",
        "A ReviewLoop, DelegationChain, or Escalation call site that re-implements acceptance with truthiness instead of calling Compose.accepted.",
        "A stop verdict (Supervisor allDone, ScanFixVerify resolved, DriftDetector drifted) read with the `in` operator, which admits an inherited property, instead of Object.hasOwn plus strict equality to true."
      ],
      paths: [
        "src/internal/Compose.vibe",
        "src/ReviewLoop.ts",
        "src/DelegationChain.ts",
        "src/Escalation.ts",
        "src/Supervisor.ts",
        "src/ScanFixVerify.ts",
        "src/DriftDetector.ts"
      ]
    },
    {
      id: "decorator-envelope-no-widening",
      title: "A decorated or composed flow never declares fewer capabilities or effects than the flows it calls",
      threat:
        "A flow author wraps a privileged flow (or adds an approval member) so the composite's declared capabilities and effect envelope hide what actually runs, bypassing policy checks keyed on those declarations.",
      lookFor: [
        "Decorate, Intervene, or Runbook restating only a gated flow's authority while also calling a separately supplied approval flow; sequence the calls without clipping the approval's authority.",
        "Compose.intersectCapabilities or intersectEffects used where a union of called members is required, or an envelope_conflict check that can be skipped when the template declares none."
      ],
      paths: [
        "src/internal/Decorate.ts",
        "src/internal/Compose.vibe",
        "src/Intervene.ts",
        "src/Runbook.ts"
      ]
    },
    {
      id: "model-output-bounds",
      title: "Plans, task lists, and rounds derived from model output stay within declared bounds",
      threat:
        "A planner or boss model returns an oversized plan, deep tree, or endless revise loop and burns another tenant's shared model budget or runner capacity.",
      lookFor: [
        "Supervisor, Trellis, DelegationChain, Recursion, or MapReduce iterating a model-returned task or leaf list without a maxDepth, maxRounds, or width cap checked before dispatch.",
        "Supervisor.run dispatching every task the boss plan returns with no cap on the task count, so one plan multiplies worker calls by maxRounds.",
        "Trellis running a model-authored parallel node with concurrency \"unbounded\" where fuel does not bound the leaves started at once.",
        "Optimizer, ReviewLoop, or Stalling with execution that exceeds the declared round count, or a bound accepting non-safe-integer or Infinity values.",
        "Bounded or MergeQueue concurrency admitting 0, negative, NaN, or unbounded widths.",
        "Burndown launching more items than concurrency or capacity slots allow, or a lineage that continues past maxRounds."
      ],
      paths: [
        "src/Supervisor.ts",
        "src/Trellis.ts",
        "src/DelegationChain.ts",
        "src/Recursion.ts",
        "src/MapReduce.ts",
        "src/Optimizer.ts",
        "src/ReviewLoop.ts",
        "src/internal/Stalling.ts",
        "src/Bounded.ts",
        "src/MergeQueue.ts",
        "src/Burndown.ts"
      ]
    },
    {
      id: "untrusted-key-records",
      title: "Records keyed by model- or input-supplied ids cannot collide with prototype or protocol keys",
      threat:
        "An item id, task id, or worker type such as __proto__ or constructor supplied by a model routes work to the wrong worker, overwrites another item's result, or pollutes a prototype.",
      lookFor: [
        "A lookup like routes[task.workerType] or members[name] without Object.hasOwn, or a record built by assignment from input ids instead of Object.fromEntries or a null-prototype object.",
        "Quarantine or Sidecar outcome envelopes where a member's own value can be mistaken for the Quarantined or Succeeded protocol tag."
      ],
      paths: [
        "src/Kanban.ts",
        "src/Supervisor.ts",
        "src/Panel.ts",
        "src/Bounded.ts",
        "src/Quarantine.ts",
        "src/Sidecar.ts",
        "src/CheckSuite.ts",
        "src/Burndown.ts"
      ]
    },
    {
      id: "cache-key-isolation",
      title: "Pattern option snapshots preserve validation and key material",
      threat:
        "A caller changes pattern options after declaration to bypass validation or change key material, causing a run to reuse a result for different inputs.",
      lookFor: [
        "A pattern that captures caller options by reference so a later edit changes key material or bypasses validation (DriftDetector, Kanban, MergeQueue snapshots)."
      ],
      paths: ["src/DriftDetector.ts", "src/Kanban.ts", "src/MergeQueue.ts"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: {
    check,
    circular,
    docs,
    docsFiles,
    fmt,
    lib,
    lint,
    reviewDocsAgainstCode,
    reviewJsdocAgainstCode,
    test,
    ...securityReview
  }
})
