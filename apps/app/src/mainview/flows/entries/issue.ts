import { Schema } from "effect"
import { flow, NumberedTarget } from "./Declare"
import type { CommandActions } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import { isPracticeRepo } from "../../state/practice/PracticeRepository"

export const namespace: Namespace = { id: "issue", label: "Issue flows", summary: "Research, reproduce, and implement an issue" }

export const issueFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({ name: "issue.flows", summary: "Inspect the flows available for an issue", runtimeAny: ["cloud", "practice"], input: NumberedTarget,
    handler: ({ number, repo }) => actions.inspectIssueFlows(number, repo) }),
  flow({ name: "issue.repro", summary: "Research and reproduce an issue before implementation", runtimeAny: ["cloud", "practice"], input: NumberedTarget,
    handler: ({ number, repo }) => actions.runIssueFlow("repro", number, repo) }),
  flow({ name: "issue.poc", summary: "Build a proof of concept for an issue", runtimeAny: ["cloud", "practice"], input: NumberedTarget,
    confirm: "ask an agent to build a proof of concept", handler: ({ number, repo }) => actions.runIssueFlow("poc", number, repo) }),
  flow({ name: "issue.implement", summary: "Plan and implement an issue with the workspace's coding flow", runtimeAny: ["cloud", "practice"], input: NumberedTarget,
    confirm: "research, plan, and implement the issue using the workspace's configured checks",
    handler: ({ number, repo }) => isPracticeRepo(repo)
      ? actions.suggestTutorialChange(repo, `Implement issue #${number}; research its context, then plan the fix before changing code.`)
      : actions.runIssueImplementation(number, repo) }),
  flow({ name: "issue.add-flow", summary: "Add a flow to the issue namespace", runtimeAny: ["cloud", "practice"],
    form: { args: payload => JSON.stringify(payload), fields: { description: { label: "What should this issue flow do?" } } },
    input: Schema.Struct({ number: Schema.Number, repo: Schema.optional(Schema.String), description: Schema.String }),
    handler: ({ number, repo, description }) => isPracticeRepo(repo)
      ? "Practice repositories can't take new flows yet."
      : actions.createWorkflow(`Create a flow under issue. for issue #${number}: ${description}`, repo) }),
]
