# Start here

Smithers combines typed durable flows, a coding agent, a repository build graph and an embedded product UI. Follow the owner of a behavior before changing it: the agent calls capabilities, a flow describes work, a runtime executes the plan, and a card projects state for a person.

## Choose the owning layer

| Concern | Start here |
| --- | --- |
| Declare a named action or compose a flow | `packages/smithers/flows/flow` |
| Supply SQL, execution stores and platform services | `packages/smithers/flows/src/Runtime.ts` |
| Attach Node or Bun host implementations | `NodeRuntime` or `BunRuntime` in the same package |
| Run a schema-bound model step | `packages/smithers/agent/src/AgentAction.ts` |
| Declare repository dependencies and checks | `PACKAGE.ts`, using `@smthrs/targets` |
| Add a product interaction | `apps/ui/AGENTS.md`, then the existing flow registry and card family |

The runtime and UI laws are boundaries for contributors. They are not evidence that every desired coding feature already exists.

## Follow the durable path

An action declares its name and schemas; its implementation is an Effect layer. A flow body composes calls into a plan without performing the side effects. The runtime supplies the engine, journal, run store and platform services. Reopening the same execution identity lets the engine reuse recorded work rather than starting the external operations again.

The coding agent uses this machinery too. Its generated JavaScript cells run in QuickJS and call registered capabilities through `ctx.call`. The host chooses the models and the capability envelope. A model's explanation is evidence to assess, not an authority to create a second execution system.

## Follow the product path

Slash commands, buttons and agent tools share one flow; missing required input becomes a schema-derived form. React components project state held in TanStack DB and changed through an actor-tagged dispatcher. Current onboarding policy keeps the UI and chat history in the main view and summons only the composer through Command-K / Control-K, superseding the older always-visible-composer requirement. Every required interaction needs a keyboard completion path.

Follow the [configured host](coding-host.md) into the [request lifecycle](coding-request.md), [planning memory](coding-planning.md), [disposable prototype](coding-poc.md), [owner correction](coding-correction.md) and [coding evidence UI](coding-ui.md). Read the [mythical contract](coding-direction.md) and [interaction study](coding-experience.md) as intended direction, separately from current implementation.

Start with the linked focused pages. The wiki writer records captured source references, content identity and semantic verification state in each generated page record. A verified source snapshot does not establish that a build passed or that production was deployed.
