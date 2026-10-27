# Flows reference

> Create, edit and run your own flows.

Open [Flows](https://smithers.sh/app/flows) to see your saved flows and drafts. Members and above can create and run personal flows.

## Create a flow

Choose **New flow**, enter a name and what it should do, then submit. In Chat, `/flow.new greet Return a greeting` starts the same draft. Type `/` to find commands; see the [command reference](https://smithers.sh/docs/commands/).

The draft shows its questions, code and checks. Answer any questions. **Save** becomes available when the draft is ready and its checks pass. A failed draft shows why and offers **Draft again**.

## Edit and inspect

On Flows, **Edit** starts a draft from the saved flow's latest source. Describe the change, review the resulting code and checks, then choose **Save**.

**Code** opens the saved source for direct editing. Saving creates another revision. **Delete** removes a saved flow or an unfinished draft.

## Run a flow

Choose **Run**, or type `/flow.run greet` in Chat. An optional input follows the name: `/flow.run greet Hello`.

A run uses the saved revision selected when it starts. Later edits do not change that run. Its run page shows progress, results or a failure reason.

Personal code runs in the browser's isolated realm. A flow that needs a machine says **Needs a sandbox** and cannot run yet.

## SDK file flows

System flows are protected actions; personal revisions do not replace them.

The CLI and SDK also load file flows from `.smithers/flows/<name>/flow.ts`. See the [flow API](/docs/reference/api/flow/) and [CLI reference](/docs/reference/cli/). The app's Flows page manages personal flows; repository file-flow overrides and activation controls are not available there.
