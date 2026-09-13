/*
 * The `issues` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { payloadFor } from "../SlashPayload"
import { flow, NumberedTarget } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"
import type { CommandActions } from "./Declare"

/** The `issues` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "issues", label: "Issues", summary: "GitHub issues" }

/** The `issues.*` flows: GitHub issues. */
export const issuesFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({ name: "issue.flows", summary: "Inspect the flows available for an issue", runtimeAny: ["cloud", "practice"], input: NumberedTarget,
    handler: ({ number, repo }) => actions.inspectIssueFlows(number, repo) }),
  flow({ name: "issue.repro", summary: "Research and reproduce an issue before implementation", runtimeAny: ["cloud", "practice"], input: NumberedTarget,
    handler: ({ number, repo }) => actions.runIssueFlow("repro", number, repo) }),
  flow({ name: "issue.poc", summary: "Build a proof of concept for an issue", runtimeAny: ["cloud", "practice"], input: NumberedTarget,
    confirm: "ask an agent to build a proof of concept", handler: ({ number, repo }) => actions.runIssueFlow("poc", number, repo) }),
  flow({ name: "issue.implement", summary: "Plan an issue's implementation for review", runtimeAny: ["cloud", "practice"], input: NumberedTarget,
    confirm: "inspect the issue and prepare its implementation plan",
    handler: ({ number, repo }) => actions.suggestTutorialChange(repo, `Implement issue #${number}; research its context, then plan the fix before changing code.`) }),
  flow({ name: "issue.add-flow", summary: "Add a flow to the issue namespace", runtimeAny: ["cloud", "practice"],
    form: { args: payload => JSON.stringify(payload), fields: { description: { label: "What should this issue flow do?" } } },
    input: Schema.Struct({ number: Schema.Number, repo: Schema.optional(Schema.String), description: Schema.String }),
    handler: ({ number, repo, description }) => actions.createWorkflow(`Create a flow under issue. for issue #${number}: ${description}`, repo) }),
  flow({
    name: "issues",
    hidden: true,
    grammar: args => payloadFor("issues.list", args),
    summary: "List a repository's issues",
    runtimeAny: ["cloud", "local.repositories", "practice"],
    args: "[open|closed|all] [owner/repo]",
    input: Schema.Struct({
      filter: Schema.optional(Schema.Literals(["open", "closed", "all"])),
      repo: Schema.optional(Schema.String)
    }),
    handler: ({ filter, repo }) => actions.listIssues(filter ?? "open", repo)
  }),
  flow({
    name: "issues.list",
    summary: "List a repository's issues",
    runtimeAny: ["cloud", "local.repositories", "practice"],
    args: "[open|closed|all] [owner/repo]",
    input: Schema.Struct({
      filter: Schema.optional(Schema.Literals(["open", "closed", "all"])),
      repo: Schema.optional(Schema.String)
    }),
    handler: ({ filter, repo }) => actions.listIssues(filter ?? "open", repo)
  }),
  flow({
    name: "issues.view",
    summary: "Open an issue with its comments",
    /* The practice repository (state/practice) answers without the cloud; its key also skips the sign-in gate. */
    runtimeAny: ["cloud", "practice"],
    args: "<number> [owner/repo]",
    requires: ["signed-in"],
    input: NumberedTarget,
    handler: ({ number, repo }) => actions.viewIssue(number, repo)
  }),
  flow({
    name: "issues.create",
    form: { fields: { repo: { optionsFrom: "cloud-repos", kind: "text" } } },
    summary: "Create an issue",
    runtime: ["cloud"],
    args: "<title> [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({ title: Schema.String, repo: Schema.optional(Schema.String) }),
    handler: ({ title, repo }) => actions.createIssue(title, repo)
  }),
  flow({
    name: "issues.close",
    summary: "Close an issue",
    runtimeAny: ["cloud", "practice"],
    args: "<number> [owner/repo]",
    requires: ["signed-in"],
    input: NumberedTarget,
    handler: ({ number, repo }) => actions.setIssueState(number, "closed", repo)
  }),
  flow({
    name: "issues.reopen",
    summary: "Reopen a closed issue",
    runtimeAny: ["cloud", "practice"],
    args: "<number> [owner/repo]",
    requires: ["signed-in"],
    input: NumberedTarget,
    handler: ({ number, repo }) => actions.setIssueState(number, "open", repo)
  }),
  flow({
    name: "issues.comment",
    form: { fields: { repo: { optionsFrom: "cloud-repos", kind: "text" } } },
    summary: "Comment on an issue",
    runtimeAny: ["cloud", "practice"],
    args: "<number> <text> [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({
      number: Schema.Number,
      text: Schema.String,
      repo: Schema.optional(Schema.String)
    }),
    handler: ({ number, text, repo }) => actions.commentOnIssue(number, text, repo)
  })
]

/** The Linear links on an issue, registered after the `linear.*` and `sync.*` flows. */
export const issuesLinearFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    name: "issues.link-linear",
    form: { fields: { number: { label: "Issue number" }, identifier: { label: "Linear identifier" }, repo: { optionsFrom: "cloud-repos", kind: "text" } } },
    summary: "Link an issue to a Linear identifier",
    runtime: ["cloud"],
    args: "<number> <identifier> [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({
      number: Schema.Number,
      identifier: Schema.String,
      repo: Schema.optional(Schema.String)
    }),
    handler: ({ number, identifier, repo }) => actions.linkIssueLinear(number, identifier, repo)
  }),
  flow({
    name: "issues.unlink-linear",
    summary: "Remove an issue's Linear link",
    runtime: ["cloud"],
    confirm: "remove the issue's Linear link",
    /* The identifier typed back is the flow's own input: the seam unlinks only when it matches, whoever invoked. */
    args: "<number> <identifier> [owner/repo]",
    requires: ["signed-in"],
    input: Schema.Struct({
      number: Schema.Number,
      identifier: Schema.optional(Schema.String),
      repo: Schema.optional(Schema.String)
    }),
    handler: ({ number, identifier, repo }) => actions.unlinkIssueLinear(number, identifier, repo)
  })
]
