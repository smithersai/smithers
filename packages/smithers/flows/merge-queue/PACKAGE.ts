import { BuildAndCheckTypeScriptPackage, SdkRules } from "@smthrs/repo-targets"
/** Standard package targets for the merge queue, plus a security review of what may move the target. */
import { Smithers } from "@smthrs/targets"
import * as Input from "@smthrs/targets/Input"

const cwd = "packages/smithers/flows/merge-queue"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  sources: Input.glob("src/**/*.ts"),
  cwd
})

/** Security review: `security` reviews the diff, `securityAudit` audits the package. */
const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**", "docs/**", "README.md", "lean/**"],
  checks: [
    {
      id: "only-green-lands",
      title: "The target moves only onto a tree with a complete green result for exactly that tree",
      threat:
        "A change reaches the target branch untested, on a partial result, or as a tree other than the tested one.",
      lookFor: [
        "A path in Step.ts that changes `main` other than `land`, or `land` setting `main` to anything but the found run's own tree.",
        "`green` accepting an empty required list, a missing check, or a result set with a failure.",
        "`live` accepting a run whose tree does not extend the target, or whose parts are not the current revision of queued changes.",
        "A `result` that overwrites an earlier result for the same check, or is recorded on a run other than the one named."
      ],
      paths: ["src/Step.ts"]
    },
    {
      id: "reference-parity",
      title: "The kernel matches the Lean reference definition for definition",
      threat:
        "The implementation drifts from the proved model, so the theorems no longer describe the code that moves the target.",
      lookFor: [
        "A definition in src/Step.ts, src/Policy.ts, src/Predict.ts or src/Trace.ts changed without the same change in lean/MergeQueue and regenerated test/fixtures.",
        "A new event, status or state field in src/Basic.ts that lean/MergeQueue/Basic.lean does not have.",
        "A guard weakened in TypeScript relative to the Lean `step`."
      ],
      paths: ["src/Step.ts", "src/Policy.ts", "src/Predict.ts", "src/Trace.ts", "src/Basic.ts"]
    },
    {
      id: "unmergeable-needs-reason",
      title: "A change leaves the queue as unmergeable only with a recorded reason",
      threat:
        "An agent discards someone's change with no explanation, or an agent's stale answer ends a later attempt.",
      lookFor: [
        "`gaveUp` accepting an empty detail, a change that is not being fixed, or an attempt other than the current one.",
        "`blame` marking a change unmergeable while fix attempts remain."
      ],
      paths: ["src/Step.ts"]
    }
  ]
})

/** Will's SDK-wide rules (apps/mvp/docs/rules.md): `importRules` runs with `test`; `jevRules` is manual. */
const { importRules, jevRules } = SdkRules({ cwd, role: "library" })

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, importRules, jevRules, lib, lint, test, ...securityReview }
})
