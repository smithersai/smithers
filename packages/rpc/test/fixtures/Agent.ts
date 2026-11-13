import type { AgentCard } from "../../src/AgentCard.ts"
import type { Action } from "../../src/CardAction.ts"
import { at } from "./_shared.ts"
import { type Story, story } from "./_story.ts"

const base: AgentCard = {
  name: "implementer",
  instructions_path: ".smithers/flows/todo/instructions/implementer.md",
  role: "coding",
  model: "gpt-6.1-sol",
  provider: "OpenAI",
  available: ["gpt-6.1-sol", "gpt-6-astra"],
  runs: [
    { id: "run-41", title: "T12 · Card model contracts", state: "done", at },
    { id: "run-42", title: "T15 · Wire Home", state: "running", at }
  ],
  owner: true
}
// Change model is settings.model.set for the agent's role (owner only; agents never).
const change = (agent: AgentCard): Action => ({
  tag: "settings.model.set",
  label: "Change model",
  args: { role: agent.role },
  input: [{
    name: "model",
    label: "Model",
    kind: "choice",
    choices: [...agent.available],
    required: true,
    value: agent.model
  }]
})
// Without cardId, todo.new opens a Draft for the person to review and commit.
const edit = (agent: AgentCard): Action => ({
  tag: "todo.new",
  label: "Edit instructions",
  args: { text: `Edit the agent instructions in ${agent.instructions_path}` }
})
const fast: AgentCard = {
  ...base,
  name: "app agent",
  instructions_path: ".smithers/instructions/app.md",
  role: "fast",
  model: "llama-4-scout",
  provider: "Cerebras",
  available: ["llama-4-scout", "qwen-3-coder"]
}
const jev: AgentCard = {
  ...base,
  name: "reviewer",
  instructions_path: ".smithers/flows/todo/instructions/reviewer.md",
  role: "jev",
  model: "typesafe-ai/jev",
  provider: "AI Gateway",
  available: ["typesafe-ai/jev"]
}

export const fixtures = {
  coding: story("The coding agent, as the owner", base, {
    actions: [change(base), edit(base)],
    expect: ["implementer", "gpt-6.1-sol", "T12 · Card model contracts", "Change model"]
  }),
  fast: story("The app agent on the fast model", fast, {
    actions: [change(fast), edit(fast)],
    expect: [".smithers/instructions/app.md", "Cerebras"]
  }),
  jev: story("The Decisions model's agent", jev, { actions: [change(jev), edit(jev)], expect: ["AI Gateway"] }),
  member_view: story("The coding agent, as a member", { ...base, owner: false }, {
    actions: [edit(base)],
    expect: ["implementer", ".smithers/flows/todo/instructions/implementer.md"]
  }),
  idle: story("An agent with no runs yet", { ...base, runs: [] }, {
    actions: [change(base), edit(base)],
    expect: [".smithers/flows/todo/instructions/implementer.md"]
  })
} satisfies Record<string, Story<AgentCard>>
