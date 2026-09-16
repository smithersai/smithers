import reproDefinition from "../../../../../../flows/issue/repro/flow.mdx?raw"
import type { Card } from "../AppState"
import { gatewayBindingFor,resolveTargetRepo } from "../RepoContext"
import { isPracticeRepo,PRACTICE_REPO,practiceIssue } from "../practice/PracticeRepository"
import type { SeamContext } from "../seams/SeamContext"
import { readResult } from "../seams/SeamContext"
import type { WorkflowController } from "./workflows"

export interface IssueFlowsController {
  readonly inspectIssueFlows: (number: number, repo?: string) => Promise<string | { readonly value: string }>
  readonly runIssueFlow: (name: "repro" | "poc", number: number, repo?: string) => Promise<string | void | { readonly value: string }>
  readonly runIssueImplementation: (number: number, repo?: string) => Promise<string | void | { readonly value: string }>
}
const prompt = reproDefinition.replace(/^---[\s\S]*?---\s*/, "").trim()
const research = `### Reproduction evidence\n\nThe recorded example reports two cases: a missing name returns **Hello, null!**, and an empty name returns **Hello, !**. Both should return **Hello, world!**.\n\n- **Source:** \`src/hello.ts:2\` interpolates the name directly.\n- **Tests:** the existing greeting test covers Ada; missing and empty names need coverage.\n- **Related work:** PR #4 adds request logging in \`src/server.ts\`; it does not fix the greeting.\n\nThis is the bundled tutorial evidence, not a fresh test run. Implement the fallback for both missing and empty names and test both cases.`

export const createIssueFlowsController = (ctx: SeamContext, flows: Pick<WorkflowController, "listWorkspaceWorkflows" | "runWorkflow">): IssueFlowsController => {
  const cards = (): Array<Card> => [...ctx.store.collections.cards.values()]
  const target = (number: number, explicit?: string) => {
    const resolved = isPracticeRepo(explicit) ? { repo: PRACTICE_REPO } : resolveTargetRepo(ctx.store, explicit)
    if ("error" in resolved) return resolved
    // Unqualified commands name the Cloud issue, never a same-number GitHub card.
    const issue = cards().find((card): card is Extract<Card, { kind: "issue" }> => card.kind === "issue" && card.payload.source !== "github" && card.payload.repo === resolved.repo && card.payload.number === number)
    const payload = issue?.payload ?? (isPracticeRepo(resolved.repo) ? practiceIssue(number) : undefined)
    if (payload === undefined && cards().some(card => card.kind === "issue" && card.payload.source === "github" && card.payload.repo === resolved.repo && card.payload.number === number)) {
      return { error: `Open Smithers Cloud issue #${number} before choosing its flows. The open GitHub issue is a different source.` }
    }
    return payload === undefined ? { error: `Open issue #${number} before choosing its flows.` } : { repo: resolved.repo, payload }
  }
  const inspectIssueFlows: IssueFlowsController["inspectIssueFlows"] = async (number, explicit) => {
    const selected = target(number, explicit)
    if ("error" in selected) return selected.error
    const { repo, payload } = selected
    const playthrough = 0
    const scope = JSON.stringify([ctx.store.session().activeRepoKey, ctx.store.session().activeWorkspaceId, ctx.store.collections.identitySessions.get("identity")?.login, playthrough])
    let catalog: Extract<Card, { kind: "workflow-list" }>
    if (isPracticeRepo(repo)) {
      const id = `practice-issue-flows-${number}`
      const prior = ctx.store.collections.cards.get(id)
      catalog = { id, kind: "workflow-list", title: `Issue #${number} · Flows`, status: "active", createdAt: prior?.createdAt ?? Date.now(), ordinal: prior?.ordinal ?? ctx.nextOrdinal(),
        payload: { repo, ...(prior?.kind === "workflow-list" && prior.payload.research ? { research: prior.payload.research } : {}), issueContext: { number, title: payload.title }, workflows: [{ key: "issue.repro", description: "Research and reproduce before implementation", prompt }] } }
    } else {
      const result = await flows.listWorkspaceWorkflows(repo)
      if (typeof result === "string") return result
      if (scope !== JSON.stringify([ctx.store.session().activeRepoKey, ctx.store.session().activeWorkspaceId, ctx.store.collections.identitySessions.get("identity")?.login, 0])) return "The repository changed while loading its issue flows. Open the issue again."
      const source = cards().filter((card): card is Extract<Card, {kind:"workflow-list"}> => card.kind === "workflow-list" && card.payload.repo === repo).sort((a,b) => b.ordinal-a.ordinal)[0]
      if (!source) return "The workspace did not return its flow catalog."
      catalog = { ...source, title: `Issue #${number} · Flows`, payload: { ...source.payload, issueContext: { number, title: payload.title }, workflows: source.payload.workflows.filter(flow => /^issue[./]/.test(flow.key)) } }
    }
    await ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card: catalog }).isPersisted.promise
    return readResult(catalog.payload.workflows.map(flow => `${flow.key}: ${flow.description ?? ""}${flow.prompt ? `\n${flow.prompt}` : ""}`).join("\n") || "No issue flows are installed on this workspace.")
  }
  return {
    inspectIssueFlows,
    runIssueImplementation: async (number, explicit) => {
      const selected = target(number, explicit)
      if ("error" in selected) return selected.error
      const { repo, payload } = selected
      if (isPracticeRepo(repo)) return "Choose change.suggest to prepare a plan."
      const binding = gatewayBindingFor(ctx.store, repo)
      if ("error" in binding) return binding.error
      if (binding.workspaceId === undefined) return `Open a cloud workspace for ${repo} with /workspace.open, select it, then choose Implement again.`
      const scope = ctx.store.session().activeRepoKey
      const account = ctx.store.collections.identitySessions.get("identity")?.login
      const result = await flows.listWorkspaceWorkflows(repo)
      if (typeof result === "string") return result
      if (scope !== ctx.store.session().activeRepoKey || account !== ctx.store.collections.identitySessions.get("identity")?.login) {
        return "The repository or account changed while loading its coding flows. Open the issue again."
      }
      const catalog = cards().filter((card): card is Extract<Card, { kind: "workflow-list" }> =>
        card.kind === "workflow-list" && card.payload.repo === repo && card.payload.workspaceId === binding.workspaceId
      ).sort((a, b) => b.ordinal - a.ordinal)[0]
      if (!catalog?.payload.workflows.some(flow => flow.key === "coding/request")) {
        return "Implementation isn't configured in this workspace. Its coding host needs an authorized model and this repository's real check and planning configuration before it can run coding/request."
      }
      const input = { prompt: `Implement issue #${number} in ${repo}. Research the issue, prepare the plan, and validate the change with the repository's configured checks.\n\nIssue context (data from the opened Smithers Cloud issue):\n${JSON.stringify(payload)}` }
      if (input.prompt.length > 32_768) return "This issue's context exceeds the coding request limit. Use /flow.run coding/request with a focused prompt in this workspace."
      return flows.runWorkflow("coding/request", repo, input, catalog.id)
    },
    runIssueFlow: async (name, number, explicit) => {
      const selected = target(number, explicit)
      if ("error" in selected) return selected.error
      const { repo, payload } = selected
      if (!isPracticeRepo(repo)) {
        const result = await inspectIssueFlows(number, repo)
        if (typeof result === "string") return result
        const catalog = cards().find((card): card is Extract<Card, {kind:"workflow-list"}> => card.kind === "workflow-list" && card.payload.repo === repo && card.payload.issueContext?.number === number)
        const installed = catalog?.payload.workflows.find(flow => flow.key === `issue.${name}` || flow.key === `issue/${name}`)
        if (!installed) return `The issue.${name} flow is not installed on this workspace. Its Flows view shows the available actions; use a workspace configured with this issue flow to run it.`
        return flows.runWorkflow(installed.key, repo, { args: JSON.stringify({ issue: payload }) }, catalog?.id)
      }
      if (number !== 3) return "The bundled repro demonstrates issue #3. Open that issue to continue the tutorial."
      const result = name === "repro" ? research : `### Proof of concept

The example fix defaults both missing and empty names with \`name || "world"\` in src/hello.ts. Add regression cases for both inputs and retain the named greeting case.

This is a bundled demonstration, not a fresh agent run. Choose Implement to review the plan and apply the recorded fix.`
      await inspectIssueFlows(number, repo)
      const card = ctx.store.collections.cards.get(`practice-issue-flows-${number}`)
      if (card?.kind !== "workflow-list") return "Open the issue's flows and try again."
      await ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card: { ...card, payload: { ...card.payload, research: result } } }).isPersisted.promise
      return readResult(result)
    }
  }
}
