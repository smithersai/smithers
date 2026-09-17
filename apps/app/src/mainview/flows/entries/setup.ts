import { Schema } from "effect"
import { CardTarget, flow, type CommandActions } from "./Declare"
import type { FlowEntry, Namespace } from "../registry"

export const namespace: Namespace = { id: "setup", label: "Repository setup", summary: "Configure and test repository jobs" }
export { namespace as ciNamespace } from "./ci"
export { namespace as choresNamespace } from "./chores"
const Repository = Schema.Struct({ repo: Schema.optional(Schema.String) })
const jsonForm = { args: (payload: Readonly<Record<string, unknown>>) => JSON.stringify(payload) }

export const setupFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({ name: "issues.setup", summary: "Handle issues", input: Repository,
    handler: ({ repo }) => actions.openRepositorySetup("issues", repo) }),
  flow({ name: "review.setup", summary: "Review PRs", input: Repository,
    handler: ({ repo }) => actions.openRepositorySetup("review", repo) }),
  flow({ name: "ci.setup", summary: "Set up CI", input: Repository,
    handler: ({ repo }) => actions.openRepositorySetup("ci", repo) }),
  flow({ name: "feature.setup", summary: "Build a feature", input: Repository,
    handler: ({ repo }) => actions.openRepositorySetup("feature", repo) }),
  flow({ name: "chores.setup", summary: "Automate a chore", input: Repository,
    handler: ({ repo }) => actions.openRepositorySetup("chores", repo) }),
  flow({ name: "setup.guide", summary: "Read this setup's configuration and repository evidence", hidden: true, discloseToAgent: true, args: "<cardId>", input: CardTarget,
    handler: ({ cardId }) => actions.guideRepositorySetup(cardId) }),
  flow({ name: "setup.configure", summary: "Edit a repository job draft", hidden: true, discloseToAgent: true, args: '<JSON: {cardId, field: "step.<id>.mode|step.<id>.prompt|<draft field>", value}>', form: jsonForm,
    input: Schema.Struct({ cardId: Schema.String, field: Schema.String, value: Schema.Json }),
    handler: ({ cardId, field, value }) => actions.configureRepositorySetup(cardId, field, value) }),
  flow({ name: "setup.view", summary: "Show a setup section", hidden: true, discloseToAgent: true, args: '<JSON: {cardId, view: "flows|prompts|checks|evals|test|work", step?}>', form: jsonForm,
    input: Schema.Struct({ cardId: Schema.String, view: Schema.Literals(["flows", "prompts", "checks", "evals", "test", "work"]), step: Schema.optional(Schema.String) }),
    handler: ({ cardId, view, step }) => actions.viewRepositorySetup(cardId, view, step) }),
  flow({ name: "setup.work", summary: "Prepare manual work for a configured repository job", hidden: true, discloseToAgent: true, args: '<JSON: {cardId, stepId, field?: "prompt|source|number", value?}>', form: jsonForm,
    input: Schema.Struct({ cardId: Schema.String, stepId: Schema.String,
      field: Schema.optional(Schema.Literals(["prompt", "source", "number"])), value: Schema.optional(Schema.Json) }),
    handler: ({ cardId, stepId, field, value }) => actions.prepareRepositoryWork(cardId, stepId, field, value) }),
  flow({ name: "setup.run", summary: "Inspect, test, enable or run a repository job", hidden: true, discloseToAgent: true, args: '<JSON: {cardId, operation: "inspect|evaluate|trial|apply|pause|run", manual?}>', form: jsonForm,
    input: Schema.Struct({ cardId: Schema.String, operation: Schema.Literals(["inspect", "evaluate", "trial", "apply", "pause", "run"]),
      manual: Schema.optional(Schema.Struct({ stepId: Schema.String, prompt: Schema.String,
        subject: Schema.optional(Schema.Struct({ source: Schema.Literals(["github", "smithers-cloud"]), kind: Schema.Literals(["issue", "pr"]), number: Schema.Number })) })) }),
    confirm: "run this repository setup operation",
    handler: ({ cardId, operation, manual }) => actions.runRepositorySetup(cardId, operation, manual) }),
  flow({ name: "setup.retry", summary: "Retry the setup request", hidden: true, discloseToAgent: true, args: "<cardId>", input: CardTarget,
    confirm: "retry this repository setup operation",
    handler: ({ cardId }) => actions.retryRepositorySetup(cardId) }),
]
